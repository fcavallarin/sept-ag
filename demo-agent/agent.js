import { Command } from "commander";
import OpenAI from "openai";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import readline from "node:readline/promises";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8001/mcp";
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/v1";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";

function resultToText(result) {
  return (result.content ?? [])
    .filter(item => item.type === "text")
    .map(item => item.text)
    .join("\n");
}

async function runAgent() {
  const llm = new OpenAI({
    baseURL: OLLAMA_URL,
    apiKey: "ollama",
  });

  const mcp = new Client({
    name: `demo-agent`,
    version: "1.0.0",
  });

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await mcp.connect(transport);

  const availableTools = await mcp.listTools();

  const llmTools = availableTools.tools.map(tool => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    },
  }));

  console.log("MCP tools:", availableTools.tools.map(tool => tool.name).join(", "));
  console.log();

  const messages = [{
    role: "system",
    content: `You are the demo agent. Use the available tools when needed. Do not claim an action succeeded unless a tool confirms it.`,
  }];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    while (true) {
      let prompt;

      try {
        prompt = (await rl.question("You: ")).trim();
      } catch {
        console.log();
        break;
      }

      if (!prompt) continue;
      if (["exit", "quit"].includes(prompt.toLowerCase())) break;

      messages.push({
        role: "user",
        content: prompt,
      });

      while (true) {
        const response = await llm.chat.completions.create({
          model: OLLAMA_MODEL,
          messages,
          ...(llmTools.length ? {
            tools: llmTools,
            tool_choice: "auto",
          } : {}),
        });

        const assistantMessage = response.choices[0].message;
        messages.push(assistantMessage);

        if (!assistantMessage.tool_calls?.length) {
          console.log(`Agent: ${assistantMessage.content}`);
          break;
        }

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments || "{}");

          console.log(`Calling ${toolName}:`, args);

          const result = await mcp.callTool({
            name: toolName,
            arguments: args,
          });

          console.log("call done");

          const toolResult = resultToText(result);
          console.log(`MCP result: ${toolResult}`);

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResult,
          });
        }
      }
    }
  } finally {
    rl.close();
    await mcp.close();
  }
}

const program = new Command();

program
  .action(runAgent);

await program.parseAsync();