import { Ollama } from "ollama";
import type { Options, Tool } from "ollama";
import type { ChatRequest, ChatResponse, ProviderAdapter, ToolCall } from "./types.js";

export interface OllamaOptions {
  id: string;
  /** e.g. http://localhost:11434 — from settings.ollamaBaseUrl. */
  host: string;
}

type WireMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
};

/** Maps neutral messages → Ollama wire messages. Pure, testable. */
export function mapMessages(messages: ChatRequest["messages"]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const m of messages) {
    const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : m.role;
    const msg: WireMessage = { role, content: m.content };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      msg.tool_calls = m.toolCalls.map((tc) => ({
        function: { name: tc.name, arguments: parseArgs(tc.arguments) },
      }));
    }
    wire.push(msg);
  }
  return wire;
}

function parseArgs(args: string): Record<string, unknown> {
  if (args === "") return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Maps Ollama tool_calls → our neutral ToolCall[]. */
export function mapToolCalls(
  calls: { function?: { name?: string; arguments?: Record<string, unknown> } }[] | undefined,
): ToolCall[] | undefined {
  const out: ToolCall[] = [];
  for (const c of calls ?? []) {
    const fn = c.function;
    if (!fn || typeof fn.name !== "string") continue;
    out.push({ id: `call-${out.length}`, name: fn.name, arguments: JSON.stringify(fn.arguments ?? {}) });
  }
  return out.length > 0 ? out : undefined;
}

/** Local-first adapter for Ollama (no key required). */
export function createOllamaAdapter({ id, host }: OllamaOptions): ProviderAdapter {
  const client = new Ollama({ host });

  return {
    id,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const chatRequest = { model: req.model, messages: mapMessages(req.messages), stream: false as const };
      const options: Partial<Options> = {};
      if (req.temperature !== undefined) options.temperature = req.temperature;
      if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;
      if (req.numContext !== undefined) options.num_ctx = req.numContext;

      const resp = await client.chat({
        ...chatRequest,
        ...(Object.keys(options).length > 0 ? { options } : {}),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((t) => ({
                type: "function" as const,
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.inputSchema as unknown as NonNullable<Tool["function"]["parameters"]>,
                },
              })),
            }
          : {}),
      });

      const message: ChatResponse["message"] = { role: "assistant", content: resp.message?.content ?? "" };
      const toolCalls = mapToolCalls(resp.message?.tool_calls);
      if (toolCalls) message.toolCalls = toolCalls;

      return {
        provider: id,
        model: resp.model ?? req.model,
        message,
        usage: {
          inputTokens: resp.prompt_eval_count ?? 0,
          outputTokens: resp.eval_count ?? 0,
        },
      };
    },
  };
}