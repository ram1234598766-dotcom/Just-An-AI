import { GoogleGenAI } from "@google/genai";
import type { GenerateContentConfig, Part, Schema } from "@google/genai";
import type { ChatRequest, ChatResponse, ProviderAdapter, ToolCall } from "./types.js";

export interface GeminiOptions {
  id: string;
  apiKey: string;
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface MappedGeminiRequest {
  systemInstruction?: string;
  contents: GeminiContent[];
}

/** Maps neutral messages → Gemini contents (system becomes systemInstruction). */
export function mapMessages(messages: ChatRequest["messages"]): MappedGeminiRequest {
  const systemInstruction =
    messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") || undefined;

  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    const role = m.role === "assistant" ? ("model" as const) : ("user" as const);
    const parts: GeminiPart[] = [];
    if (m.content) parts.push({ text: m.content });
    if (m.role === "tool") {
      const name = m.toolCallId ?? "function";
      parts.push({ functionResponse: { name, response: { result: m.content.slice(0, 100_000) } } });
    }
    for (const tc of m.toolCalls ?? []) {
      parts.push({ functionCall: { name: tc.name, args: parseArgs(tc.arguments) } });
    }
    contents.push({ role, parts });
  }

  const out: MappedGeminiRequest = { contents };
  if (systemInstruction) out.systemInstruction = systemInstruction;
  return out;
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

/** Maps Gemini functionCall parts → our neutral ToolCall[]. */
export function mapToolCalls(parts: unknown[] | undefined): ToolCall[] | undefined {
  const out: ToolCall[] = [];
  for (const p of parts ?? []) {
    if (typeof p !== "object" || p === null) continue;
    const fc = (p as { functionCall?: { name?: unknown; args?: unknown } }).functionCall;
    if (!fc || typeof fc.name !== "string") continue;
    out.push({
      id: `call-${out.length}`,
      name: fc.name,
      arguments: JSON.stringify(
        fc.args && typeof fc.args === "object" ? (fc.args as Record<string, unknown>) : {},
      ),
    });
  }
  return out.length > 0 ? out : undefined;
}

/** Adapter for Google Gemini via the official SDK. */
export function createGeminiAdapter({ id, apiKey }: GeminiOptions): ProviderAdapter {
  const client = new GoogleGenAI({ apiKey, vertexai: false });

  return {
    id,

    async chat(req: ChatRequest): Promise<ChatResponse> {
      const { systemInstruction, contents } = mapMessages(req.messages);
      const config: GenerateContentConfig = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (req.temperature !== undefined) config.temperature = req.temperature;
      if (req.maxTokens !== undefined) config.maxOutputTokens = req.maxTokens;
      if (req.tools && req.tools.length > 0) {
        config.tools = [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.inputSchema as unknown as Schema,
            })),
          },
        ];
      }

      const resp = await client.models.generateContent({ model: req.model, contents, config });
      const parts: Part[] = resp.candidates?.[0]?.content?.parts ?? [];
      const text = parts.map((p) => p.text ?? "").join("");

      const message: ChatResponse["message"] = { role: "assistant", content: text };
      const toolCalls = mapToolCalls(parts);
      if (toolCalls) message.toolCalls = toolCalls;

      return {
        provider: id,
        model: resp.modelVersion ?? req.model,
        message,
        usage: {
          inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    },
  };
}