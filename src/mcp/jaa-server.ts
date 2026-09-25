import { McpServer } from "../mcp/server.js";
import { createDefaultRegistry } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";

/**
 * Create and configure an MCP server that exposes jaa's built-in tools
 * over stdio. Each jaa tool becomes an MCP tool with the same name, description,
 * and input schema. When called, the tool runs with a ToolContext scoped to
 * the current working directory.
 */
export function createJaaMcpServer(allowBash = false): McpServer {
  const server = new McpServer({ name: "jaa", version: "0.1.0" });
  const registry = createDefaultRegistry();
  const toolCtx: ToolContext = {
    root: process.cwd(),
    cwd: process.cwd(),
    allowBash,
  };

  for (const tool of registry.list()) {
    server.addTool(
      tool.name,
      tool.description,
      tool.inputSchema as Record<string, unknown>,
      async (args) => {
        const result = await registry.execute(tool.name, JSON.stringify(args), toolCtx);
        return { content: [{ type: "text", text: result }] };
      },
    );
  }

  return server;
}