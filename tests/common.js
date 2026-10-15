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
export const MCP_SERVER_PORT = 1213
export const NUM_DEVICES = 4
export const SEPT_VERSION = "0.1.2"
export const PROXY_PORT = 1223


export function assert(cond, err) {
  if (!cond) {
    throw new Error(err)
  }
}

export async function sleep(ms) {
  await new Promise(r => setTimeout(r, ms))
}

export const runMCPClient = async () => {

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
    new URL(`http://127.0.0.1:${PROXY_PORT}/mcp`),
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

  proc.stdout.on("data", data => stdout.push(...`${data}`.split('\n')));
  proc.stderr.on("data", data => stderr.push(...`${data}`.split('\n')));

  return {
    send: text => proc.stdin.write(`${text}\n`),
    output: () => stdout,
    errors: () => stderr,
    close: () => proc.kill(),
    done: new Promise(resolve => proc.on("close", resolve)),
    wait: async out => {
      while (true) {
        for (const o of stdout) {
          if (out.test(o)) {
            return o
          }
        }
        await sleep(300)
      }
    }
  };
};

export const run = (...args) => {
  return runCLI(process.execPath,
    [
      path.resolve("..", "src", "cli.js"),
      ...args,
      "--data-dir", "./data",
      "--config", "./data/config.json"
    ]
  )
}
