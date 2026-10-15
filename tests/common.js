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
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = path.dirname(__filename);

export const SERVER_PORT = 18788
export const MCP_SERVER_PORT = 1215
export const NUM_DEVICES = 4
export const SEPT_VERSION = "0.1.2"
export const PROXY_PORT = 1228


export function assert(cond, err) {
  if (!cond) {
    throw new Error(err)
  }
}

export async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms))
}

export async function waitFor(fn, timeoutMs = 10000, what = "condition") {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const r = await fn()
    if (r) {
      return r
    }
    await sleep(200)
  }
  throw new Error(`Timeout waiting for ${what}`)
}

export const runMCPClient = async (clientNumber = 0) => {

  const mcpClient = new Client(
    {
      name: `sept-ab-test`,
      version: "0.1.0",
    },
    {
      versionNegotiation: {
        mode: "auto",
      },
    },
  );


  const mcpTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${PROXY_PORT + clientNumber}/mcp`),
  );


  await mcpClient.connect(
    mcpTransport,
  )

  return mcpClient

}

export const runMCPServer = async () => {

  const mcpHandler = createMcpHandler(
    async () => {


      const server = new McpServer({
        name: `SEPT MCP Test Server`,
        version: "0.1.0",
      })
      const tools = [
        {
          description: "tool 1",
          name: "tool-1"

        }
      ]
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

            return this.request(
              `mcp.tools.call.${tool.name}`,
              {
                arguments: arguments_,
              }
            )
          }
        )

        console.log(`Exposed MCP tool: ${tool.name}`)
      }

      return server
    },
    { responseMode: "json" }
  )

  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: error => {
      console.error(`MCP HTTP handler error:`, error)
    },
  })

  const app = createMcpExpressApp()

  app.all("/mcp", (req, res) => {
    void nodeHandler(req, res, req.body)
  })

  return app.listen(
    MCP_SERVER_PORT,
    "127.0.0.1",
    () => {
      console.log(
        `MCP proxy listening on ${MCP_SERVER_PORT}`
      )
    }
  )

}

export const runCLI = (cmd, args, opts = {}) => {
  // console.log(cmd, args)
  const proc = spawn(cmd, [...args], {
    stdio: ["pipe", "pipe", "pipe"],
    ...opts
  });

  const stdout = [];
  const stderr = []

  let exitCode = null

  proc.stdout.on("data", data => stdout.push(...`${data}`.split('\n')));
  proc.stderr.on("data", data => stderr.push(...`${data}`.split('\n')));
  proc.on("exit", code => { exitCode = code ?? "signal" });

  return {
    send: text => proc.stdin.write(`${text}\n`),
    output: () => stdout,
    errors: () => stderr,
    close: () => proc.kill(),
    clear: () => {
      stdout.splice(0)
      stderr.splice(0)
    },
    done: new Promise(resolve => proc.on("close", resolve)),
    wait: async (out, timeoutMs = 60000) => {
      const start = Date.now()
      while (true) {
        for (const o of stdout) {
          if (out.test(o)) {
            return o
          }
        }
        if (exitCode !== null) {
          throw new Error(`Process exited (${exitCode}) before ${out}\n${stderr.join("\n")}`)
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error(`Timeout waiting for ${out}\n${stderr.join("\n")}`)
        }
        await sleep(300)
      }
    }
  };
};

export const run = (...args) => {
  return runCLI(process.execPath,
    [
      path.resolve(__dirname, "..", "src", "cli.js"),
      ...args,
      "--data-dir", "./data",
      ...(!args.includes("--config") ? ["--config", "./data/config.json"] : [])
    ],
    { cwd: __dirname }
  )
}

export const writeConfig = (location, clientNumber = 0) => {
  fs.writeFileSync(
    location,
    JSON.stringify({
      "sept": {
        "restEndpoint": `http://127.0.0.1:${SERVER_PORT}`,
        "logLevel": "info"
      },
      "client": {
        "id": `cl${clientNumber}`,
        "listenHost": "127.0.0.1",
        "port": PROXY_PORT + clientNumber
      },
      "server": {
        "id": "serv",
        "transport": "streamable-http",
        "url": `http://127.0.0.1:${MCP_SERVER_PORT}/mcp`,
      }
    }),
    "utf-8"
  )
}