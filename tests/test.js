import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdir, cp } from 'node:fs/promises';
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs"
import { Command, Option } from "commander";
import { SeptAGAdmin } from '../src/admin.js'
import { SeptMcpClient } from '../src/client.js'
import { mock } from "node:test";
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
} from "@modelcontextprotocol/server"
import { toNodeHandler } from "@modelcontextprotocol/node"
import { createMcpExpressApp } from "@modelcontextprotocol/express"

import {
  __filename,
  __dirname,
  SERVER_PORT,
  MCP_SERVER_PORT,
  NUM_DEVICES,
  SEPT_VERSION,
  PROXY_PORT,
  run,
  runCLI,
  sleep,
  runMCPServer,
  runMCPClient,
  assert,
  waitFor
} from './common.js'

let septServer, appClient, appServer, mcpServer, mcpClient
const serverOutput = []



// class TestApp {

//   // answers 

//   constructor(app) {

//     this.app = new app(new Command())
//     this.stdout = []
//     this.stderr = []

//     this.app.command.configureOutput({
//       writeOut: str => this.stdout.push(str),
//       writeErr: str => this.stderr.push(str)
//     });

//     this.app.command.exitOverride();

//     mock.module("node:readline/promises", {
//       namedExports: {
//         createInterface: () => ({
//           question: async () => "1234",
//           close: () => { }
//         })
//       }
//     });
//   }

//   clear() {
//     this.stdout = []
//     this.stderr = []
//   }

//   async exec(...cmd) {
//     await this.app.command.parseAsync(cmd, { from: "user" });
//   }
// }


class SeptAGTest {
  async init() {
    const dataDir = path.resolve(__dirname, "data")
    const serverDir = path.resolve(dataDir, "test-server")
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { recursive: true });

    mcpServer = await runMCPServer()

    fs.writeFileSync(
      path.resolve(dataDir, "config.json"),
      JSON.stringify({
        "sept": {
          "restEndpoint": `http://127.0.0.1:${SERVER_PORT}`,
          "logLevel": "info"
        },
        "client": {
          "id": "cl",
          "listenHost": "127.0.0.1",
          "port": PROXY_PORT
        },
        "server": {
          "id": "serv",
          "transport": "streamable-http",
          "url": `http://127.0.0.1:${MCP_SERVER_PORT}/mcp`,
        }
      }),
      "utf-8"
    )

    execFileSync("git", [
      "clone", "--branch", `v${SEPT_VERSION}`, '--depth', '1', 'https://github.com/fcavallarin/sept.git'
    ], { cwd: dataDir })

    execFileSync(
      "npm",
      ["run", "scaffold:server", "--", "test", serverDir],
      { stdio: "inherit", cwd: path.resolve(dataDir, "sept") }
    )

    execFileSync(
      "npm", ["install"],
      { stdio: "inherit", cwd: serverDir }
    )
    const wranglerConf = path.resolve(serverDir, "wrangler.jsonc")
    await cp(path.resolve(__dirname, "wrangler.jsonc"), wranglerConf)

    execFileSync(
      "npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local"],
      { stdio: ["ignore", "pipe", "pipe"], cwd: serverDir }
    )

    const serverUrl = `http://127.0.0.1:${SERVER_PORT}`
    septServer = await runCLI("npx",
      ["wrangler", "dev", "--config", wranglerConf, "--port", SERVER_PORT],
      {
        cwd: serverDir,
      }
    )

    await septServer.wait(/\[wrangler:info\] Ready on/)
    appClient = run("client")
    appServer = run("server")
  }

  async _sync_client_devices(exclude = []) {
    for (let i = 1; i <= NUM_DEVICES; i++) {
      await this[`appDevice${i}`].sync()
    }
  }

  async test_admin(testId) {

    let clData = await appClient.wait(/^eyJk/)
    let srData = await appServer.wait(/^eyJk/)

    const admin = run("admin", "connect", "my-connection", clData, "--new-server", srData)
    const pinServer = (await admin.wait(/PIN Server/)).split(": ")[1]
    const pinClient = (await admin.wait(/PIN Client/)).split(": ")[1]

    await appClient.wait(/PIN/)
    await appClient.send(pinClient)

    await appServer.wait(/PIN/)
    await appServer.send(pinServer)

    await appServer.wait(/Pairing done/)
    await appClient.wait(/Pairing done/)
    console.log("Pairing done")
    await appClient.wait(/MCP proxy listening on/)
    // Don't let the next admin command run concurrently with this one: they
    // are the same device sharing admin.db.
    await admin.done

    // await appServer.wait(/Discovered MCP tools: \[ 'tool 1' \]/)
    console.log("Starting MCP client")
    mcpClient = await runMCPClient()
  }

  async test_grantall(testId) {
    let res
    res = await mcpClient.listTools()
    assert(res.tools.length === 0, "Tools list must be empty")
    const admin = run("admin", "grant-all", "my-connection")
    await admin.done
    // grant-all returns once the policy update is on the relay; the client
    // applies it asynchronously, so poll instead of asserting right away.
    res = await waitFor(async () => {
      const r = await mcpClient.listTools()
      return r.tools.length > 0 && r
    }, 10000, "granted tools to appear")
    assert(res.tools.length === 1, `Tools list must NOT be empty: ${res.tools.length}`)
    assert(res.tools[0].name === "tool-1", `Wrong tool name ${res.tools[0].name}`)

  }

}

async function main() {
  const septTest = new SeptAGTest()
  await septTest.init()

  const tests = Object.getOwnPropertyNames(SeptAGTest.prototype)
    .filter(t => t.startsWith("test_"))

  const errors = []
  const exit = () => {
    septServer.close()
    appClient.close()
    appServer.close()
    if (mcpClient) {
      mcpClient.close()
    }
    mcpServer.close()
    if (errors.length > 0) {
      for (const e of errors) {
        console.log(e)
      }
      process.exit(1)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    console.log('Ctrl+C pressed')
    exit()
  })

  for (const t of tests) {
    console.log(`Running ${t}`)
    try {
      await septTest[t](t)
      console.log(`${t} ... OK`)
    } catch (e) {
      errors.push(`${t}: ${e}`)
      console.log(`${t} ... ERROR`)
    }
    console.log("---------------")
  }
  exit()
  console.log("ALL TESTS PASSED")
}

main()

