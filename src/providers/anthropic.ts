import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ChatResponse, ProviderAdapter, ToolCall } from "./types.js";

export interface AnthropicOptions {
  id: string;
  apiKey: string;
  baseURL: string;
  fetch?: typeof globalThis.fetch;
}

type WireContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface WireMessage {
  role: "user" | "assistant";
  content: string | WireContent[];
}

export interface MappedRequest {
  system?: string;
  messages: WireMessage[];
  tools?: Anthropic.Messages.Tool[];
}

/** Anthropic requires max_tokens; sane default when the caller omits it. */
export const DEFAULT_MAX_TOKENS = 2048;

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function toolToWire(tools: ChatRequest["tools"] | undefined): Anthropic.Messages.Tool[] | undefined {
  return tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

/** Maps neutral messages → Anthropic messages (system becomes the `system` param). */
export function mapMessages(
  messages: ChatRequest["messages"],
  tools: ChatRequest["tools"] | undefined,
): MappedRequest {
  const system =
    messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;

  const body: WireMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      body.push({ role: "user", content: m.content });
    } else if (m.role === "tool") {
      body.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content.slice(0, 100_000) || "ok" }],
      });
    } else {
      const content: WireContent[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parseArgs(tc.arguments) });
      }
      body.push({ role: "assistant", content });
    }
  }

  const out: MappedRequest = { messages: body };
  if (system) out.system = system;
  const wired = toolToWire(tools);
  if (wired && wired.length > 0) out.tools = wired;
  return out;
}

/** Maps Anthropic tool_use content blocks → our neutral ToolCall[]. */
export function mapToolCalls(
  blocks: { type: string; id?: string; name?: string; input?: unknown }[] | undefined,
): ToolCall[] | undefined {
  const calls = blocks
    ?.filter((b) => b.type === "tool_use" && b.id && b.name)
    .map(
      (b, i): ToolCall => ({
        id: b.id ? `${b.id}-${i}` : `call-${i}`,
        name: b.name ?? "",
        arguments: JSON.stringify(b.input ?? {}),
      }),
    );
  return calls && calls.length > 0 ? calls : undefined;
}

/** Adapter for Anthropic (Claude) via the official SDK. */
export function createAnthropicAdapter({ id, apiKey, baseURL, fetch }: AnthropicOptions): ProviderAdapter {
  const client = new Anthropic({ apiKey, baseURL, fetch });

  return {
    id,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { system, messages, tools } = mapMessages(req.messages, req.tools);
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: req.model,
        messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      if (system) params.system = system;
      if (tools) params.tools = tools;
      if (req.temperature !== undefined) params.temperature = req.temperature;

      const resp = await client.messages.create(params);
      const text = resp.content
        .map((b) => (b.type === "text" ? ((b as { text?: string }).text ?? "") : ""))
        .join("");

      const message: ChatResponse["message"] = { role: "assistant", content: text };
      const toolCalls = mapToolCalls(resp.content);
      if (toolCalls) message.toolCalls = toolCalls;

      return {
        provider: id,
        model: resp.model ?? req.model,
        message,
        usage: {
          inputTokens: resp.usage.input_tokens ?? 0,
          outputTokens: resp.usage.output_tokens ?? 0,
        },
      };
    },
  };
}