import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";

import { pairIfNeeded } from "./common.js";
import { SeptMcpChannel, toolCallEvent } from "./transport.js";
import { BaseCommand } from "./base-command.js";

export class SeptMcpServer extends BaseCommand {

  constructor(program) {
    super("server", "Run the server bridge in front of an existing MCP server", program)
    this.command
      .action(this.action("start"))
  }


  async init() {
    this.service = this.config.server
    this.mcpClient = null;
    this.mcpTransport = null;

    this.tools = [];
    this.stopping = false;
    let networkId = await this.sept.getNetworkId()
    if (!networkId) {

      await pairIfNeeded(
        this.sept,
        this.service.id,
        "server"
      );
      networkId = await this.sept.getNetworkId()
      console.log("Pairing done")
    }
    console.log(`NetworkID: ${networkId}`)

    await this.connectMcp();

    const { tools } = await this.mcpClient.listTools();

    this.tools = tools;
    this.setupMcpChannel()

    await this.sept.connect()
  }

  async stop() {
    await this.sept.disconnect()
  }


  async start() {
    await this.waitInit()

    console.log(
      `[${this.service.id}] Discovered MCP tools:`,
      this.tools.map(tool => tool.name),
    );

    const deviceId = await this.sept.getDeviceId();

    console.log(
      `[${this.service.id}] SEPT gateway connected as ${deviceId}`,
    );

    await this.sentToolsToAdmins()
  }

  async waitInit() {

    while (true) {
      const acl = await this.sept.getACL()
      if (acl.find(a => a.policy.allowedEventTypes.includes("tools.list"))) {
        break
      }
      await new Promise(r => setTimeout(r, 500))
    }
  }

  async sentToolsToAdmins() {
    const admins = await this.sept.getAdmins()
    await this.sept.send("tools.list", { tools: this.tools }, admins.map(a => a.deviceId))
  }

  async connectMcp() {

    if (this.service.transport !== "streamable-http") {
      throw new Error(
        `Unsupported MCP transport '${this.service.transport}' for service '${this.service.id}'`,
      );
    }


    this.mcpClient = new Client(
      {
        name: `sept-ag-${this.service.id}`,
        version: "0.1.0",
      },
      {
        versionNegotiation: {
          mode: "auto",
        },
      },
    );


    this.mcpTransport = new StreamableHTTPClientTransport(
      new URL(this.service.url),
    );


    await this.mcpClient.connect(
      this.mcpTransport,
    );


    console.log(
      `[${this.service.id}] Connected to MCP server at ${this.service.url}`,
    );

    console.log(
      `[${this.service.id}] MCP protocol era:`,
      this.mcpClient.getProtocolEra(),
    );

    console.log(
      `[${this.service.id}] MCP server:`,
      this.mcpClient.getServerVersion(),
    );
  }


  setupMcpChannel() {
    // One MCP session (McpServer + SeptTransport) per client device.
    this.sessions = new Map()
    this.channel = new SeptMcpChannel(this.sept, {
      logPrefix: `[${this.service.id}] `,
      maxRequestAgeMs: this.service.maxRequestAgeMs,
      clockSkewMs: this.service.clockSkewMs,
    })
    this.channel.registerTools(this.tools.map(tool => tool.name))
    this.channel.onsession = transport => this.createSession(transport)

    this.sept.on("policy.update", () => this.applyGrantsToSessions())
  }

  // Exposes the MCP server's tools to one client device. Every tool is
  // registered, but only the ones granted to the device are enabled: SEPT
  // already drops calls to tools that are not granted, this keeps tools/list
  // consistent with the grants.
  async createSession(transport) {
    const deviceId = transport.deviceId

    const server = new McpServer(
      {
        name: `sept-ag-${this.service.id}`,
        version: "0.1.0",
      },
      {
        capabilities: { tools: { listChanged: true } },
      },
    )

    const registered = new Map()
    for (const tool of this.tools) {
      registered.set(
        tool.name,
        server.registerTool(
          tool.name,
          toolConfig(tool),
          async arguments_ => this.callTool(tool, deviceId, arguments_),
        ),
      )
    }

    const session = { deviceId, server, registered }
    await this.applyGrants(session)

    await server.connect(transport)

    const onclose = transport.onclose
    transport.onclose = () => {
      onclose?.()
      if (this.sessions.get(deviceId) === session) {
        this.sessions.delete(deviceId)
      }
    }

    this.sessions.set(deviceId, session)
    console.log(`[${this.service.id}] New MCP session for ${deviceId}`)
  }

  async callTool(tool, deviceId, arguments_) {
    console.log(
      `[${this.service.id}] Calling ${tool.name}`,
      {
        senderDeviceId: deviceId,
        arguments: arguments_,
      },
    );

    return await this.mcpClient.callTool({
      name: tool.name,
      arguments: arguments_,
    });
  }

  async allowedTools(deviceId) {
    const gatewayDeviceId = await this.sept.getDeviceId();
    const graph = await this.sept.getACL();

    const relation = graph.find(edge =>
      edge.srcDeviceId === deviceId &&
      edge.dstDeviceId === gatewayDeviceId
    );

    const allowedEventTypes = relation?.policy?.allowedEventTypes ?? [];
    return new Set(
      this.tools
        .map(tool => tool.name)
        .filter(name => allowedEventTypes.includes(toolCallEvent(name))),
    )
  }

  // Enabling or disabling a tool on a connected McpServer sends
  // notifications/tools/list_changed to the client.
  async applyGrants(session) {
    const allowed = await this.allowedTools(session.deviceId)
    for (const [name, tool] of session.registered) {
      if (allowed.has(name) && !tool.enabled) {
        tool.enable()
      } else if (!allowed.has(name) && tool.enabled) {
        tool.disable()
      }
    }
    console.log(
      `[${this.service.id}] Tools allowed for ${session.deviceId}:`,
      [...allowed],
    );
  }

  async applyGrantsToSessions() {
    for (const session of this.sessions.values()) {
      await this.applyGrants(session)
    }
  }


  async stop() {
    return
    if (this.stopping) {
      return;
    }

    this.stopping = true;

    console.log(
      `[${this.service.id}] Stopping...`,
    );

    if (this.sept) {
      try {
        await this.sept.disconnect();
      } catch (error) {
        console.error(
          `[${this.service.id}] SEPT disconnect failed:`,
          error,
        );
      }
    }

    if (this.mcpTransport) {
      try {
        await this.mcpTransport.terminateSession();
      } catch {
      }
    }


    if (this.mcpClient) {
      try {
        await this.mcpClient.close();
      } catch (error) {
        console.error(
          `[${this.service.id}] MCP close failed:`,
          error,
        );
      }
    }
  }
}


function toolConfig(tool) {
  const config = {
    description: tool.description ?? "",
    inputSchema: fromJsonSchema(
      tool.inputSchema ?? {
        type: "object",
        properties: {},
      }
    ),
  }
  if (tool.title) {
    config.title = tool.title
  }
  if (tool.annotations) {
    config.annotations = tool.annotations
  }
  if (tool.outputSchema) {
    config.outputSchema = fromJsonSchema(tool.outputSchema)
  }
  return config
}
