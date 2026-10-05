import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Option } from "commander";
import { SeptClient } from "@sept-protocol/client"
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpExpressApp } from "@modelcontextprotocol/express"
import { BaseCommand } from "./base-command.js"
import {
  betterSqliteDataStore,
  loadOrCreateSecret,
  pairIfNeeded,
} from "./common.js"

export class SeptMcpClient extends BaseCommand {
  constructor(program) {
    super("client", "Client", program)
    this.command
      .addOption(
        new Option("-p, --protocol <protocol>", "service protocol")
          .choices(["mcp", "a2a"])
          .default("mcp"),
      )
      .action(this.action("start"))
  }


  async init() {
    this.service = this.config.client

    this.gatewayDeviceId = null
    this.allowedEventTypes = []
    this.pending = new Map()

    this.mcpHandler = null
    this.httpServer = null
    this.stopping = false
    this.tools = null
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
    this.registerResponseHandler()

    this.sept.on("policy.update", () => {
      this.tools = null
    })

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

    this.httpServer = app.listen(
      this.service.port,
      this.service.listenHost,
      () => {
        console.log(
          `[${this.service.id}] MCP proxy listening on http://${this.service.listenHost}:${this.service.port}/mcp`
        )
      }
    )
  }

  async discoverGateway() {
    const ownDeviceId = await this.sept.getDeviceId()
    const graph = await this.sept.getDeviceGraph()

    const relations = graph.filter(edge => {
      if (edge.srcDeviceId !== ownDeviceId) {
        return false
      }

      const allowedEventTypes = edge.policy?.allowedEventTypes ?? []

      return allowedEventTypes.some(type =>
        type === "mcp.tools.list" ||
        type.startsWith("mcp.tools.call.")
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

  registerResponseHandler() {
    this.sept.register("mcp.response", async event => {
      if (event.senderDeviceId !== this.gatewayDeviceId) {
        console.warn(
          `[${this.service.id}] Ignoring mcp.response from`,
          event.senderDeviceId
        )
        return
      }

      const {
        requestId,
        result,
        error,
        rpc,
      } = event.payload

      const request = this.pending.get(requestId)

      if (!request) {
        console.warn(`[${this.service.id}] Unknown requestId: ${requestId}`)
        return
      }

      clearTimeout(request.timeout)
      this.pending.delete(requestId)

      if (error) {
        request.reject(
          new Error(error.message ?? "Unknown MCP gateway error")
        )
        return
      }

      if (rpc?.error) {
        request.reject(
          new Error(rpc.error.message ?? "MCP JSON-RPC error")
        )
        return
      }

      request.resolve(result ?? rpc?.result)
    })
  }

  async request(eventType, payload = {}) {
    const requestId = crypto.randomUUID()

    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Timeout waiting for ${eventType}`))
      }, this.service.requestTimeoutMs)

      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
      })
    })

    try {
      await this.sept.send(
        eventType,
        {
          requestId,
          ...payload,
        },
        [this.gatewayDeviceId]
      )
    } catch (error) {
      const request = this.pending.get(requestId)

      if (request) {
        clearTimeout(request.timeout)
        this.pending.delete(requestId)
      }

      throw error
    }

    return responsePromise
  }

  async buildMcpServer() {
    if(this.tools === null){
      const discovery = await this.request("mcp.tools.list")
      this.tools = discovery?.tools ?? []
    }

    console.log(
      `[${this.service.id}] Allowed MCP tools:`,
      this.tools.map(tool => tool.name)
    )

    const server = new McpServer({
      name: `SEPT MCP Proxy (${this.service.id})`,
      version: "0.1.0",
    })

    for (const tool of this.tools) {
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

          return this.request(
            `mcp.tools.call.${tool.name}`,
            {
              arguments: arguments_,
            }
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

    for (const [requestId, request] of this.pending) {
      clearTimeout(request.timeout)

      request.reject(
        new Error(`Proxy stopped while waiting for ${requestId}`)
      )
    }

    this.pending.clear()

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