/**
 * Provider-agnostic message/tool/usage types. Adapters map these to and from
 * each vendor's wire format. The agent loop (Phase 3) only sees these.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments string (kept raw — parsed only where needed). */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** tool messages: the call id they answer to. */
  toolCallId?: string;
  /** assistant messages: tool calls proposed by the model. */
  toolCalls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema describing the arguments — root is always an object schema. */
  inputSchema: { type: "object"; properties?: Record<string, unknown>; required?: string[] } & Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  /** Assistant reply — may carry toolCalls for a follow-up round. */
  message: ChatMessage;
  usage: Usage;
  model: string;
  provider: string;
}

export interface ChatStreamChunk {
  delta: string;
  usage?: Usage;
}

export interface ProviderAdapter {
  readonly id: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Optional; the router falls back to non-streaming when absent. */
  stream?(req: ChatRequest): AsyncIterable<ChatStreamChunk>;
}

export interface ResolvedModel {
  provider: string;
  model: string;
  adapter: ProviderAdapter;
  /** Where the key came from, so callers can surface a useful error. */
  keySource?: "process" | "project" | "home" | "keyring";
}