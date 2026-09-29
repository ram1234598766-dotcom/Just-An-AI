import React from "react";
import { Box, Text } from "ink";
import { clip, formatDuration, formatTokens, gauge, gaugeTone, summarize } from "./render.js";
import type { Line, LineKind, ToolCardState } from "./render.js";

/** The prefix that marks whose line this is. */
export function prefixFor(kind: LineKind): string {
  switch (kind) {
    case "user":
      return "❯ ";
    case "toolCall":
      return "  ";
    case "toolResult":
      return "  ";
    // Phase 16: a prefix, not a colour. A compaction marker is not the model
    // speaking, and colouring it like speech would make a thing the user paid
    // for look like a thing the model said.
    case "compact":
      return "~ ";
    case "notice":
      return "! ";
    // The compiler's verdict, marked as its own authority. Deliberately not a
    // speech marker: the model saying "done" and the compiler saying otherwise
    // must never look like the same kind of statement.
    case "diagnostic":
      return "  ⚠ ";
    default:
      return "";
  }
}

/**
 * The colour for a row.
 *
 * Only three kinds are coloured. `compact`, `notice` and `diagnostic` are things
 * that happened to the user rather than things anyone said, and colouring them
 * like speech would misrepresent where they came from.
 */
export function colorFor(kind: LineKind): "blue" | "yellow" | "red" | "green" | "magenta" | undefined {
  switch (kind) {
    case "user":
      return "blue";
    case "toolCall":
      return "yellow";
    case "error":
      return "red";
    case "diagnostic":
      return "red";
    case "status":
      return "green";
    default:
      return undefined;
  }
}

/** The mark that shows whether a tool call worked. */
function toolMark(state: ToolCardState["state"]): string {
  switch (state) {
    case "running":
      return "◐";
    case "ok":
      return "✓";
    case "failed":
      return "✗";
  }
}

function toolColor(state: ToolCardState["state"]): "yellow" | "green" | "red" {
  switch (state) {
    case "running":
      return "yellow";
    case "ok":
      return "green";
    case "failed":
      return "red";
  }
}

/** The right-hand column of a tool card: state, duration, and the expand hint. */
function toolMeta(card: ToolCardState): string {
  const parts: string[] = [toolMark(card.state)];
  parts.push(card.state === "running" ? "running" : formatDuration(card.elapsedMs ?? 0));
  if (card.result !== undefined) parts.push(card.expanded ? "ctrl+r collapse" : "ctrl+r expand");
  return parts.join("  ");
}

/**
 * A code block, boxed and labelled.
 *
 * Boxed rather than indented because an indented block reads as a quotation of
 * the model's prose, and the language tag is kept visible because the whole
 * point of a code block is that you know what language you are looking at.
 */
function CodeBlockView({ language, text }: { language: string | undefined; text: string }): React.JSX.Element {
  const lines = text.replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, 24);
  const hidden = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Text dimColor>
        {"╭─ "}
        {language ?? "code"}
        {" ───────"}
      </Text>
      {shown.map((line, index) => (
        // eslint-disable-next-line react/no-array-index-key -- rows are positional
        <Text key={index}>
          <Text dimColor>{"│ "}</Text>
          {line === "" ? " " : line}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>
          {"│ "}… {hidden} more line{hidden === 1 ? "" : "s"}
        </Text>
      ) : null}
      <Text dimColor>{"╰─────"}</Text>
    </Box>
  );
}

/** One transcript row. Pure — no state, no effects — so a Static list is safe. */
export function LineView({ line }: { line: Line }): React.JSX.Element {
  if (line.kind === "code" && line.code !== undefined) {
    return <CodeBlockView language={line.code.language} text={line.code.text} />;
  }

  if (line.kind === "toolCall" && line.tool !== undefined) {
    const card = line.tool;
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={toolColor(card.state)}>{toolMark(card.state)}</Text>
          <Text bold {...(card.state === "running" ? { color: "yellow" as const } : {})}>
            {" "}
            {card.name}
          </Text>
          <Text dimColor>{"  " + clip(card.args, 70)}</Text>
          <Text dimColor>{"  " + toolMeta(card)}</Text>
        </Box>
        {card.result !== undefined && card.state !== "running" ? (
          <Box>
            <Text dimColor>{"    "}</Text>
            <Text {...(card.state === "failed" ? { color: "red" as const } : {})}>
              {card.result.split("\n").map((part, index) => (index === 0 ? part : `\n    ${part}`)).join("")}
            </Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  const color = colorFor(line.kind);
  const body = line.text;
  return (
    <Box flexDirection="column">
      {body.split("\n").map((part, index) => (
        <Text key={index} {...(color !== undefined ? { color } : {})} {...(line.kind === "notice" || line.kind === "compact" ? { dimColor: true } : {})}>
          {index === 0 ? prefixFor(line.kind) : "  "}
          {part === "" ? " " : part}
          {index === body.split("\n").length - 1 && line.meta !== undefined ? " " : ""}
          {index === body.split("\n").length - 1 && line.meta !== undefined ? (
            <Text dimColor>{line.meta}</Text>
          ) : null}
        </Text>
      ))}
    </Box>
  );
}

export interface StatusBarProps {
  provider: string;
  model: string;
  /** Cumulative tokens in and out for this session. */
  inputTokens: number;
  outputTokens: number;
  /** The budget the request is trimmed to. */
  budget: number;
  /** Tokens currently in the prompt, for the gauge. */
  contextTokens: number;
  /** Turns completed in this session. */
  turns: number;
  /** Milliseconds since the last submit, while a turn is running. */
  elapsedMs: number;
  busy: boolean;
  /** Short hint for what the session is, e.g. the session id. */
  sessionId?: string;
  /** A one-line reason to show instead of the model name, e.g. a stall. */
  notice?: string;
}

/**
 * The persistent status line.
 *
 * Everything on it is a number the operator would otherwise have to ask for:
 * which model is answering, what the turn has cost, how much context is left
 * before trimming starts, and how long it has been going. The context gauge is
 * the one that earns its place — compaction and trimming both happen silently,
 * and without it the user has no way of knowing they are about to happen.
 */
export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const ratio = props.budget > 0 ? props.contextTokens / props.budget : 0;
  const tone = gaugeTone(ratio);
  const model = `${props.provider}/${props.model}`;

  return (
    <Box flexDirection="column">
      <Text dimColor>{"─".repeat(4)} jaa {model}</Text>
      <Box>
        <Text dimColor>{"  turn "}</Text>
        <Text>{props.turns}</Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text dimColor>{"ctx "}</Text>
        <Text {...(tone === "ok" ? {} : { color: tone === "warn" ? ("yellow" as const) : ("red" as const) })}>
          {gauge(ratio)}
        </Text>
        <Text dimColor>
          {" "}
          {formatTokens(props.contextTokens)}/{formatTokens(props.budget)}
        </Text>
        <Text dimColor>{"  ·  "}</Text>
        <Text dimColor>{"tok "}</Text>
        <Text>
          {formatTokens(props.inputTokens)}in/{formatTokens(props.outputTokens)}out
        </Text>
        {props.busy ? (
          <>
            <Text dimColor>{"  ·  "}</Text>
            <Text color="yellow">{formatDuration(props.elapsedMs)}</Text>
          </>
        ) : null}
        {props.sessionId !== undefined ? (
          <>
            <Text dimColor>{"  ·  "}</Text>
            <Text dimColor>{clip(props.sessionId, 12)}</Text>
          </>
        ) : null}
      </Box>
      {props.notice !== undefined ? (
        <Box>
          <Text color="yellow">{"  " + summarize(props.notice, 100)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
