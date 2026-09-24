import type { ChatMessage, ToolCall } from "../providers/types.js";

/** One renderable row of the chat transcript. Pure and serializable. */
export type LineKind = "user" | "assistant" | "toolCall" | "toolResult" | "error";

export interface Line {
  id: number;
  kind: LineKind;
  /** Plain-text content to render. */
  text: string;
  /** Optional short grey label shown after the text (e.g. "(ok)"). */
  meta?: string;
}

/** Clip long text to a single bounded line ending in " …". */
export function clip(text: string, max: number): string {
  const t = text.replace(/\r\n/g, "\n");
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\n.*$/, "");
  return `${cut.trimEnd()} …`;
}

/** Collapse a multi-line value into a single bounded line. */
export function summarize(value: string, max: number): string {
  return clip(value.replace(/\s+/g, " ").trim(), max);
}

export function formatToolCall(call: ToolCall): string {
  let args = call.arguments;
  try {
    args = JSON.stringify(JSON.parse(args));
  } catch {
    // keep the raw arguments; they are already plain text
  }
  return `${call.name}(${clip(args, 140)})`;
}

export function summarizeToolResult(result: string, ok: boolean): { text: string; meta: string } {
  return { text: summarize(result, 200), meta: ok ? "(ok)" : "(failed)" };
}

/**
 * Convert a message list (a session transcript or a turn delta) into display
 * lines. Used for both the initial/resumed view and the live transcript.
 */
export function linesFromMessages(messages: ChatMessage[], idOffset = 0): Line[] {
  const lines: Line[] = [];
  let next = idOffset;
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push({ id: next++, kind: "user", text: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.content) lines.push({ id: next++, kind: "assistant", text: msg.content });
      for (const call of msg.toolCalls ?? []) {
        lines.push({ id: next++, kind: "toolCall", text: formatToolCall(call) });
      }
    } else if (msg.role === "tool") {
      lines.push({
        id: next++,
        kind: "toolResult",
        text: summarize(msg.content, 200),
        meta: "(tool)",
      });
    }
  }
  return lines;
}