import crypto from "node:crypto"
import { mkdirSync } from "node:fs"
import pc from "picocolors"
import { join } from "node:path"
import { SeptClient } from "@sept-protocol/client"
import { Option } from "commander";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpExpressApp } from "@modelcontextprotocol/express"

import {
  betterSqliteDataStore,
  loadOrCreateSecret,
  pairIfNeeded,
} from "./common.js"

import { BaseCommand } from "./base-command.js";
import { error } from "node:console";

export class SeptAGAdmin extends BaseCommand {
  constructor(program) {
    super("admin", "Manage AgentBridge devices, services, and grants", program)
    this.command
      .command("connect")
      .description("Add a new connection")
      .argument("name", "Connection's name")
      .argument("device-data", "Base64 encoded device data")
      .addOption(
        new Option("--new-server <device-data>", "Create a new server")
          .conflicts("existingServer")
      )
      .addOption(
        new Option("--existing-server <device-id>", "Use an existing server")
          .conflicts("newServer")
      )
      .action(this.action("connect"))

    this.command
      .command("grant-tool")
      .description("Grant permission")
      .argument("connection-name", "Connection name")
      .argument("tool", "Tools name")
      .action(this.action("grantTool"))

    this.command
      .command("grant-all")
      .description("Grant permissions to all tools")
      .argument("connection-name", "Connection name")
      .action(this.action("grantAll"))

    this.command
      .command("revoke-all")
      .description("Revoke permissions to all tools")
      .argument("connection-name", "Connection name")
      .action(this.action("revokeAll"))

    this.command
      .command("revoke-tool")
      .description("Revoke permission")
      .argument("connection-name", "Connection name")
      .argument("tool", "Tools name")
      .action(this.action("revokeTool"))

    this.command
      .command("connection")
      .description("Get connection details")
      .argument("connection-name", "Connection name")
      .action(this.action("connection"))
  }

  async init() {
    let networkId = await this.sept.getNetworkId()
    if (!networkId) {
      await this.sept.bootstrap()
      networkId = await this.sept.getNetworkId()
      console.log("Bootstrap done")
    }
    console.log(`NetworkID: ${networkId}`)
    this.connectionsStorage = this.sept.appStorage("connections")
    this.sept.register("tools.list", async event => {
      const connections = await this.connectionsStorage.all()
      const connection = connections.find(c => c.value.server === event.senderDeviceId)
      await this.connectionsStorage.set(connection.key, cur => {
        return {
          ...cur,
          tools: event.payload.tools
        }
      })
    })
    await this.sept.connect()
  }

  async stop() {
    await this.sept.disconnect()
  }

  parseDeviceData(b64Data) {
    return JSON.parse(Buffer.from(b64Data, "base64").toString("utf8"))
  }

  async connect(name, clientDeviceData, options) {
    if (await this.connectionsStorage.get(name)) {
      throw new Error(`Connection with name ${name} already exists`)
    }

    const { existingServer, newServer } = options

    if (!existingServer && !newServer) {
      throw new Error("One of --new-server or --existing-server is required")
    }

    const client = this.parseDeviceData(clientDeviceData)

    if (client.metadata.role !== "client") {
      throw new Error(`Wrong client role: ${client.metadata.role}`)
    }

    const { pin: pinClient, pairing: pairingClient } = await this.sept.addDevice(client)
    let serverDeviceId, pairingServer
    if (newServer) {
      const server = this.parseDeviceData(newServer)
      if (server.metadata.role !== "server") {
        throw new Error(`Wrong server role`)
      }
      const { pin: pinServer, pairing } = await this.sept.addDevice(server)
      console.log(`PIN Server: ${pinServer}`)
      serverDeviceId = server.deviceId
      pairingServer = pairing
    } else {
      if (!await this.sept.getDevices.find(d => d.id === existingServer)) {
        throw new Error(`Device ${existingServer} not found`)
      }
      serverDeviceId = existingServer
    }

    console.log(`PIN Client: ${pinClient}`)

    if (newServer) {
      await pairingServer
    }
    await pairingClient

    await this.sept.grant(client.deviceId, serverDeviceId, ["mcp.initialize", "mcp.tools.list"])
    await this.sept.grant(serverDeviceId, client.deviceId, ["mcp.response"])
    await this.connectionsStorage.set(name, {
      name,
      tools: [],
      server: serverDeviceId,
      client: client.deviceId
    });
    for (const admins of await this.sept.getAdmins()) {
      await this.sept.grant(serverDeviceId, admins.deviceId, ["tools.list"])
    }
  }

  async grantTool(connectionName, tool) {
    const connection = await this.connectionsStorage.get(connectionName)
    await this.sept.grant(connection.client, connection.server, [`mcp.tools.call.${tool}`])
  }

  async grantAll(connectionName) {
    const connection = await this.connectionsStorage.get(connectionName)
    const tools = connection.tools.map(t => `mcp.tools.call.${t.name}`)
    await this.sept.grant(connection.client, connection.server, tools)
  }

  async revokeAll(connectionName) {
    const connection = await this.connectionsStorage.get(connectionName)
    const tools = connection.tools.map(t => `mcp.tools.call.${t.name}`)
    await this.sept.revoke(connection.client, connection.server, tools)
  }


  async revokeTool(connectionName, tool) {
    const connection = await this.connectionsStorage.get(connectionName)
    await this.sept.revoke(connection.client, connection.server, [`mcp.tools.call.${tool}`])
  }

  async connection(connectionName) {
    const c = await this.connectionsStorage.get(connectionName)
    if(!c){
      throw new Error(`Connection ${connectionName} not found`)
    }
    const acl = await this.sept.getACL()
    const enabledTools = acl.find(a => a.srcDeviceId === c.client && a.dstDeviceId === c.server)?.policy?.allowedEventTypes || []
    console.log(`Client: ${c.client}`)
    console.log(`Server: ${c.server}`)
    console.log(`Tools:`)
    for(const t of c.tools){
      const enabled = enabledTools.includes(`mcp.tools.call.${t.name}`)
      console.log(`  ${enabled ? pc.green('✓') : pc.red('✗')} ${t.name}`)
    }
  }
}