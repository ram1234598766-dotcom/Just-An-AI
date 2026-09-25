export const MCP_PROTOCOL_VERSION = "2024-11-05";

export type McpRequestId = string | number;

export interface McpRequest {
  jsonrpc: "2.0";
  id: McpRequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  jsonrpc: "2.0";
  id: McpRequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: McpContent[];
  isError?: boolean;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
    logging?: Record<string, unknown>;
  };
  serverInfo: { name: string; version: string };
  instructions?: string;
}
