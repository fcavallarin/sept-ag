#!/usr/bin/env node

import { Command, Option } from "commander";

import {SeptAGAdmin} from './admin.js'
import { SeptMcpClient } from "./client.js";
import { SeptMcpServer } from "./server.js";

const program = new Command();

program
  .name("sept-ab")
  .description("Bridge MCP and A2A services through SEPT")
  .version("0.1.0")
  .showHelpAfterError();

new SeptMcpClient(program)
new SeptMcpServer(program)
new SeptAGAdmin(program)

program.parseAsync().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
