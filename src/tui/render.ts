import type { ChatMessage, ToolCall } from "../providers/types.js";

/**
 * How a tool call ended, and how long it took.
 *
 * `running` is the state a call is in between `onToolCall` and `onToolResult`,
 * and it is deliberately a state rather than an absence: a tool that hangs must
 * look like a tool that is working, not like a tool that has not been noticed.
 */
export type ToolState = "running" | "ok" | "failed";

/**
 * The kinds a transcript row can take.
 *
 * `compact` and `notice` are Phase 16 additions, both rendered in the neutral
 * uncoloured band rather than as user or assistant speech. A compaction is
 * neither: it is something jaa did to the conversation, and colouring it like
 * the model talking would make a thing the user must know about look like a
 * thing the model said.
 *
 * `diagnostic` is Phase 17: a compiler's verdict on a file the agent just wrote.
 * It gets its own kind so it can never be mistaken for the model's opinion of
 * its own work, which is the one confusion that matters here — the model says
 * "done", the compiler disagrees, and both are in the transcript.
 */
export type LineKind =
  | "user"
  | "assistant"
  | "toolCall"
  | "toolResult"
  | "error"
  | "compact"
  | "notice"
  | "diagnostic"
  | "status"
  | "code";

/** One run of fenced or indented code inside an assistant message. */
export interface CodeBlock {
  /** The language tag, when the fence named one. */
  language: string | undefined;
  /** The code itself, with fences removed and tabs preserved. */
  text: string;
}

export interface Line {
  id: number;
  kind: LineKind;
  /** Plain-text content to render. */
  text: string;
  /** Optional short grey label shown after the text (e.g. "(ok)"). */
  meta?: string;
  /** Tool lifecycle, for `toolCall` rows. */
  tool?: ToolCardState;
  /** A code run lifted out of the surrounding prose. */
  code?: CodeBlock;
}

/** What a tool card shows, and what it is currently showing. */
export interface ToolCardState {
  name: string;
  args: string;
  state: ToolState;
  /** Wall-clock milliseconds, present once the call has finished. */
  elapsedMs?: number;
  /** The result text, already summarised for a one-line body. */
  result?: string;
  /** Whether the operator has expanded the result. */
  expanded: boolean;
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
 * Split `text` into prose and code.
 *
 * Only fenced blocks are treated as code. Indented-four-spaces is CommonMark's
 * other block form, but in a terminal a model's 4-space-indented continuation
 * line is nearly always just a wrapped sentence, and turning those into code
 * blocks makes ordinary prose unreadable. A fence is unambiguous, so only a
 * fence counts.
 *
 * An unterminated fence — which is what a half-streamed message looks like — is
 * still a code block. Rendering it as prose mid-stream would flash the syntax as
 * text and then re-render, which is worse than showing it as code slightly early.
 */
export function splitCode(text: string): { prose: string; blocks: CodeBlock[] } {
  const lines = text.split("\n");
  const blocks: CodeBlock[] = [];
  const prose: string[] = [];
  let current: string[] | undefined;
  let language: string | undefined;

  for (const line of lines) {
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (current === undefined) {
      if (fence !== null) {
        current = [];
        language = fence[1] === "" ? undefined : fence[1];
        continue;
      }
      prose.push(line);
      continue;
    }
    if (fence !== null) {
      blocks.push({ language, text: current.join("\n") });
      current = undefined;
      language = undefined;
      continue;
    }
    current.push(line);
  }
  if (current !== undefined) blocks.push({ language, text: current.join("\n") });

  return { prose: prose.join("\n").replace(/\n{3,}/g, "\n\n").trim(), blocks };
}

/** How many characters of a result are shown before it is clipped. */
export const RESULT_PREVIEW_CHARS = 160;

/** How many characters a collapsed card shows; enough to recognise, not to read. */
export const RESULT_EXPANDED_CHARS = 4000;

/**
 * The body a tool card shows for a given expansion state.
 *
 * Collapsed is one line, because a card is a status not a document: the operator
 * is watching for the tool that is taking long, not reading a log. Expanded is
 * bounded anyway, so a tool that printed a megabyte cannot take over the
 * transcript.
 */
export function toolResultBody(result: string, expanded: boolean): string {
  return expanded
    ? clip(result, RESULT_EXPANDED_CHARS)
    : summarize(result, RESULT_PREVIEW_CHARS);
}

/** A duration in the largest unit that reads well: 840ms, 1.2s, 3m 04s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Token counts in thousands, so the gauge label stays narrow: 1.2k, 47k. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 100_000) {
    const thousands = count / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  return `${Math.round(count / 1000)}k`;
}

/**
 * A filled/empty bar of `width` cells for `ratio` in 0..1.
 *
 * The filled part uses `█` and the rest `░`, which are single-width in every
 * terminal font worth using, so the bar does not drift as it changes length.
 * Out-of-range ratios are clamped rather than throwing: this is a display, and a
 * display must not be the thing that crashes a turn.
 */
export function gauge(ratio: number, width = 10): string {
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(safe * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Which cell of a gauge should be drawn in the warning colour. */
export function gaugeTone(ratio: number): "ok" | "warn" | "critical" {
  if (!Number.isFinite(ratio) || ratio < 0) return "ok";
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.7) return "warn";
  return "ok";
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
    } else     if (msg.role === "assistant") {
      if (msg.content) {
        const expanded = expandMarkdown(msg.content, next);
        lines.push(...expanded);
        // `expandMarkdown` starts at `next` and increments per row, so the
        // counter resumes from however many rows it produced.
        next += expanded.length;
      }
      for (const call of msg.toolCalls ?? []) {
        lines.push({
          id: next++,
          kind: "toolCall",
          text: formatToolCall(call),
          tool: { name: call.name, args: clip(call.arguments, 140), state: "ok", expanded: false },
        });
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

/**
 * Expand assistant text into prose and code rows.
 *
 * Each paragraph of prose becomes its own row so a code block between two
 * paragraphs does not force the paragraphs into one row and lose the break. A
 * streamed message is re-expanded on every delta, so this must be pure and
 * stable: same input, same rows, or the transcript would churn.
 */
export function expandMarkdown(text: string, idOffset = 0): Line[] {
  const { prose, blocks } = splitCode(text);
  const rows: Line[] = [];
  let next = idOffset;

  const paragraphs = prose.split(/\n{2,}/).filter((p) => p.trim() !== "");
  for (const paragraph of paragraphs) {
    rows.push({ id: next++, kind: "assistant", text: paragraph.trim() });
  }
  for (const block of blocks) {
    rows.push({ id: next++, kind: "code", text: block.text, code: block });
  }
  return rows;
}
