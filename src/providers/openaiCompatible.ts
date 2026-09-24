import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import type { ChatRequest, ChatResponse, ChatStreamChunk, ProviderAdapter, ToolCall } from "./types.js";

export interface OpenAICompatibleOptions {
  id: string;
  apiKey: string;
  baseURL: string;
  /** Test seam: inject a fetch implementation (e.g. a canned responder). */
  fetch?: typeof globalThis.fetch;
}

/** Maps our neutral messages to chat.completions wire messages. Pure, testable. */
export function mapMessagesToWire(messages: ChatRequest["messages"]): ChatCompletionMessageParam[] {
  const wire: ChatCompletionMessageParam[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        wire.push({ role: "system", content: m.content });
        break;
      case "tool":
        wire.push({ role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" });
        break;
      case "user":
        wire.push({ role: "user", content: m.content });
        break;
      case "assistant": {
        const msg: { role: "assistant"; content: string; tool_calls?: ChatCompletionMessageToolCall[] } = {
          role: "assistant",
          content: m.content,
        };
        if (m.toolCalls && m.toolCalls.length > 0) {
          msg.tool_calls = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        wire.push(msg);
        break;
      }
    }
  }
  return wire;
}

function wireCallToTool(c: unknown): ToolCall | undefined {
  if (typeof c !== "object" || c === null) return undefined;
  const call = c as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  const fn = call.function;
  if (fn && typeof call.id === "string" && typeof fn.name === "string" && typeof fn.arguments === "string") {
    return { id: call.id, name: fn.name, arguments: fn.arguments };
  }
  return undefined;
}

/** Maps chat.completions tool_calls (any variant) to our neutral ToolCall[]. */
export function mapWireToolCalls(calls: unknown[] | null | undefined): ToolCall[] | undefined {
  const out: ToolCall[] = [];
  for (const c of calls ?? []) {
    const t = wireCallToTool(c);
    if (t) out.push(t);
  }
  return out.length > 0 ? out : undefined;
}

/** Pretty JSON from arbitrary schema — accepted by all OpenAI-compatible hosts. */
export function toolToWire(tools: ChatRequest["tools"] | undefined) {
  return tools?.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && "text" in p ? String(p.text) : ""))
      .join("");
  }
  return "";
}

/**
 * Adapter for the whole OpenAI-compatible family (OpenAI, Groq, DeepSeek,
 * Mistral, Together, xAI, Azure OpenAI, and local servers like LM Studio,
 * vLLM and llama.cpp) — they are one protocol with a baseURL swap.
 */
export function createOpenAICompatible({ id, apiKey, baseURL, fetch }: OpenAICompatibleOptions): ProviderAdapter {
  const client = new OpenAI({ apiKey, baseURL, fetch });

  return {
    id,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const params: ChatCompletionCreateParamsNonStreaming = {
        model: req.model,
        messages: mapMessagesToWire(req.messages),
        stream: false,
      };
      if (req.temperature !== undefined) params.temperature = req.temperature;
      if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;
      const tools = toolToWire(req.tools);
      if (tools) params.tools = tools;

      const completion = await client.chat.completions.create(params);
      const first = completion.choices[0]?.message;
      const message: ChatResponse["message"] = { role: "assistant", content: textOf(first?.content) };
      const toolCalls = mapWireToolCalls(first?.tool_calls as unknown[] | undefined);
      if (toolCalls) message.toolCalls = toolCalls;

      return {
        provider: id,
        model: completion.model ?? req.model,
        message,
        usage: {
          inputTokens: completion.usage?.prompt_tokens ?? 0,
          outputTokens: completion.usage?.completion_tokens ?? 0,
        },
      };
    },

    async *stream(req: ChatRequest): AsyncGenerator<ChatStreamChunk> {
      const params: ChatCompletionCreateParamsStreaming = {
        model: req.model,
        messages: mapMessagesToWire(req.messages),
        stream: true,
      };
      if (req.temperature !== undefined) params.temperature = req.temperature;
      if (req.maxTokens !== undefined) params.max_tokens = req.maxTokens;
      const tools = toolToWire(req.tools);
      if (tools) params.tools = tools;

      const completion = await client.chat.completions.create(params);
      for await (const chunk of completion) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield { delta };
        if (chunk.usage) {
          yield { delta: "", usage: { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 } };
        }
      }
    },
  };
}