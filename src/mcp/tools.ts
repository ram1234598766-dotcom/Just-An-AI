import type { McpClient } from "./client.js";
import type { McpTool, McpToolCallResult } from "./types.js";
import type { ToolDef } from "../providers/types.js";

/**
 * Convert an MCP tool definition to jaa's neutral ToolDef format.
 */
export function mcpToolToDef(tool: McpTool): ToolDef {
  return {
    name: tool.name,
    description: tool.description ?? "",
    inputSchema: (tool.inputSchema ?? { type: "object" }) as ToolDef["inputSchema"],
  };
}

/**
 * All MCP tools from a set of connected clients, as jaa ToolDef[].
 */
export function allMcpTools(clients: McpClient[]): ToolDef[] {
  const defs: ToolDef[] = [];
  for (const client of clients) {
    for (const tool of client.tools) {
      defs.push(mcpToolToDef(tool));
    }
  }
  return defs;
}

/**
 * Find which MCP client owns a given tool name.
 */
export function findMcpClient(clients: McpClient[], toolName: string): McpClient | undefined {
  for (const client of clients) {
    if (client.hasTool(toolName)) return client;
  }
  return undefined;
}

/**
 * Execute a tool call through the first MCP client that advertises the tool.
 * Returns the result as a string (extracting text content from the MCP result).
 */
export async function executeMcpTool(
  clients: McpClient[],
  call: { name: string; arguments: string },
): Promise<string> {
  const client = findMcpClient(clients, call.name);
  if (!client) {
    return `tool "${call.name}" not found in any connected MCP server`;
  }

  let result: McpToolCallResult;
  try {
    result = await client.callTool(call.name, call.arguments);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `MCP tool "${call.name}" failed: ${msg}`;
  }

  if (result.isError) {
    const text = result.content.find((c) => c.type === "text");
    return `MCP tool "${call.name}" returned an error: ${text ? (text as { text: string }).text : "unknown error"}`;
  }

  // Extract text content from all content blocks
  const texts = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .filter(Boolean);

  if (texts.length === 0) return "";
  return texts.join("\n");
}
