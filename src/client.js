import { Client } from "@modelcontextprotocol/client"
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { BaseCommand } from "./base-command.js"
import { pairIfNeeded } from "./common.js"
import { RPC_EVENT, SeptMcpChannel, toolCallEvent } from "./transport.js"

export class SeptMcpClient extends BaseCommand {
  constructor(program) {
    super("client", "Run the client bridge: a local MCP endpoint for an AI agent", program)
    this.command
      .action(this.action("start"))
  }


  async init() {
    this.service = this.config.client

    this.gatewayDeviceId = null
    this.allowedEventTypes = []
    // MCP client session with the server bridge, over SEPT
    this.remote = null
    this.remoteConnecting = null

    this.mcpHandler = null
    this.httpServer = null
    this.stopping = false
    this.tools = null
    this.toolsRequest = null
    this.toolsGeneration = 0
    let networkId = await this.sept.getNetworkId()
    if (!networkId) {
      await pairIfNeeded(
        this.sept,
        this.service.id,
        "client"
      );
      networkId = await this.sept.getNetworkId()
      console.log("Pairing done")
    }
    console.log(`NetworkID: ${networkId}`)
    this.channel = new SeptMcpChannel(this.sept, {
      logPrefix: `[${this.service.id}] `,
    })

    this.sept.on("policy.update", ({ policies }) =>
      this.onPolicyUpdate(policies)
    )

    await this.sept.connect()
  }

  async stop() {
    await this.sept.disconnect()
  }



  async start() {

    const deviceId = await this.sept.getDeviceId()

    console.log(`[${this.service.id}] Connected as ${deviceId}`)

    let gateway = null
    while (gateway === null) {
      try {
        gateway = await this.discoverGateway()
      } catch (e) {
        console.log(`Waiting gateway grant`)
        await new Promise(r => setTimeout(r, 1000))
      }
    }

    this.gatewayDeviceId = gateway.gatewayDeviceId
    // this.allowedEventTypes = gateway.allowedEventTypes

    console.log(
      `[${this.service.id}] Discovered MCP gateway: ${this.gatewayDeviceId}`
    )

    console.log(
      `[${this.service.id}] Granted MCP capabilities:`,
      gateway.allowedEventTypes.filter(type => type.startsWith("mcp."))
    )

    this.mcpHandler = createMcpHandler(
      async () => await this.buildMcpServer(),
      { responseMode: "json" }
    )

    const nodeHandler = toNodeHandler(this.mcpHandler, {
      onerror: error => {
        console.error(`[${this.service.id}] MCP HTTP handler error:`, error)
      },
    })

    const app = createMcpExpressApp()

    app.all("/mcp", (req, res) => {
      void nodeHandler(req, res, req.body)
    })

    const { port, listenHost } = this.service

    // Express 5 invokes the listen callback with the error too (e.g.
    // EADDRINUSE), so check it instead of always reporting success.
    try {
      this.httpServer = await new Promise((resolve, reject) => {
        const server = app.listen(port, listenHost, error =>
          error ? reject(error) : resolve(server)
        )
      })
    } catch (error) {
      console.error(
        `[${this.service.id}] Cannot listen on ${listenHost}:${port}: ${error.message}`
      )
      // The SEPT connection would otherwise keep the process alive.
      process.exit(1)
    }

    console.log(
      `[${this.service.id}] MCP proxy listening on http://${listenHost}:${port}/mcp`
    )
  }

  async discoverGateway() {
    const ownDeviceId = await this.sept.getDeviceId()
    const graph = await this.sept.getACL()

    const relations = graph.filter(edge => {
      if (edge.srcDeviceId !== ownDeviceId) {
        return false
      }

      const allowedEventTypes = edge.policy?.allowedEventTypes ?? []

      return allowedEventTypes.some(type =>
        type === RPC_EVENT ||
        type.startsWith(toolCallEvent(""))
      )
    })

    if (relations.length === 0) {
      throw new Error(`No MCP gateway authorized for ${ownDeviceId}`)
    }

    if (relations.length > 1) {
      throw new Error(
        "Multiple MCP gateways found; explicit selection is required"
      )
    }

    const relation = relations[0]

    return {
      gatewayDeviceId: relation.dstDeviceId,
      allowedEventTypes: relation.policy?.allowedEventTypes ?? [],
    }
  }

  // Connects (once) an MCP client to the server bridge over SEPT.
  async getRemote() {
    if (this.remote) {
      return this.remote
    }

    if (this.remoteConnecting === null) {
      this.remoteConnecting = (async () => {
        const client = new Client(
          {
            name: `sept-ag-${this.service.id}`,
            version: "0.1.0",
          },
          {
            versionNegotiation: {
              mode: "auto",
            },
          },
        )

        const transport = this.channel.connect(this.gatewayDeviceId, {
          requestTimeoutMs: this.service.requestTimeoutMs,
        })

        try {
          await client.connect(transport, {
            timeout: this.service.requestTimeoutMs,
          })
        } catch (error) {
          await transport.close()
          throw error
        }

        const onclose = transport.onclose
        transport.onclose = () => {
          onclose?.()
          if (this.remote === client) {
            this.remote = null
          }
        }

        this.remote = client
        return client
      })().finally(() => {
        this.remoteConnecting = null
      })
    }

    return this.remoteConnecting
  }

  async remoteRequest(what, fn) {
    try {
      return await fn(await this.getRemote())
    } catch (error) {
      if (error?.code === "REQUEST_TIMEOUT" || /timed out/i.test(error?.message ?? "")) {
        throw new Error(`Timeout waiting for ${what}`)
      }
      throw error
    }
  }

  async onPolicyUpdate(policies = []) {
    const ownDeviceId = await this.sept.getDeviceId()

    const affectsTools = policies.some(p =>
      p.srcDeviceId === ownDeviceId &&
      (this.gatewayDeviceId === null || p.dstDeviceId === this.gatewayDeviceId)
    )

    if (!affectsTools) {
      return
    }

    // Bump the generation so an in-flight mcp.tools.list issued under the
    // old policy cannot repopulate the cache with a stale list.
    this.toolsGeneration++
    this.tools = null
    this.toolsRequest = null

    this.mcpHandler?.notify.toolsChanged()
    console.log(`[${this.service.id}] Tool permissions changed, notified agents`)
  }

  async getTools() {
    if (this.tools !== null) {
      return this.tools
    }

    if (this.toolsRequest === null) {
      const generation = this.toolsGeneration

      const request = this.remoteRequest("tools/list", remote =>
        remote.listTools(undefined, {
          timeout: this.service.requestTimeoutMs,
          // Tool permissions can change at any time: never serve a cached list
          cacheMode: "bypass",
        })
      )
        .then(discovery => {
          const tools = discovery?.tools ?? []
          if (generation === this.toolsGeneration) {
            this.tools = tools
          }
          return tools
        })
        .finally(() => {
          if (this.toolsRequest === request) {
            this.toolsRequest = null
          }
        })

      this.toolsRequest = request
    }

    return this.toolsRequest
  }

  async buildMcpServer() {
    const tools = await this.getTools()

    console.log(
      `[${this.service.id}] Allowed MCP tools:`,
      tools.map(tool => tool.name)
    )

    const server = new McpServer(
      {
        name: `SEPT MCP Proxy (${this.service.id})`,
        version: "0.1.0",
      },
      {
        capabilities: { tools: { listChanged: true } },
      }
    )

    for (const tool of tools) {
      const toolConfig = {
        description: tool.description ?? "",
        inputSchema: fromJsonSchema(
          tool.inputSchema ?? {
            type: "object",
            properties: {},
          }
        ),
      }

      if (tool.title) {
        toolConfig.title = tool.title
      }

      if (tool.annotations) {
        toolConfig.annotations = tool.annotations
      }

      if (tool.outputSchema) {
        toolConfig.outputSchema = fromJsonSchema(tool.outputSchema)
      }

      server.registerTool(
        tool.name,
        toolConfig,
        async arguments_ => {
          console.log(
            `[${this.service.id}] Calling ${tool.name} over SEPT`,
            arguments_
          )

          return this.remoteRequest(toolCallEvent(tool.name), remote =>
            remote.callTool(
              {
                name: tool.name,
                arguments: arguments_,
              },
              {
                timeout: this.service.requestTimeoutMs,
              }
            )
          )
        }
      )

      console.log(`[${this.service.id}] Exposed MCP tool: ${tool.name}`)
    }

    return server
  }

  async stop() {
    return
    if (this.stopping) {
      return
    }

    this.stopping = true

    console.log(`[${this.service.id}] Stopping...`)

    if (this.remote) {
      await this.remote.close()
    }

    if (this.httpServer) {
      await new Promise((resolve, reject) => {
        this.httpServer.close(error => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
    }

    if (this.mcpHandler) {
      await this.mcpHandler.close()
    }

    if (this.sept) {
      await this.sept.disconnect()
    }
  }
}