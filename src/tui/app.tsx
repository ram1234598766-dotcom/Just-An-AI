import React, { useCallback, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { runAgentLoop } from "../agent/loop.js";
import type { AgentLoopResult } from "../agent/loop.js";
import type { ChatMessage, ResolvedModel, ToolCall, ToolDef } from "../providers/types.js";
import { formatToolCall, linesFromMessages, summarizeToolResult } from "./render.js";
import type { Line, LineKind } from "./render.js";

export interface ChatAppProps {
  model: ResolvedModel;
  systemPrompt: string;
  tools?: ToolDef[];
  executeTool: (call: ToolCall) => Promise<string>;
  maxTurns?: number;
  tokenBudget?: number;
  temperature?: number;
  numContext?: number;
  resumeMessages: ChatMessage[];
  sessionId?: string;
  onTurnEnd?: (result: AgentLoopResult) => void;
}

type PendingLine = readonly [kind: LineKind, text: string, meta?: string];

function colorFor(kind: LineKind): "blue" | "yellow" | "red" | undefined {
  switch (kind) {
    case "user":
      return "blue";
    case "toolCall":
      return "yellow";
    case "error":
      return "red";
    default:
      return undefined;
  }
}

function prefixFor(kind: LineKind): string {
  switch (kind) {
    case "user":
      return "❯ ";
    case "toolCall":
      return "→ ";
    case "toolResult":
      return "↳ ";
    default:
      return "";
  }
}

export function ChatApp(props: ChatAppProps): React.JSX.Element {
  const initialLines = useMemo(() => linesFromMessages(props.resumeMessages), [props.resumeMessages]);
  const idRef = useRef(initialLines.length);
  const [lines, setLines] = useState<Line[]>(initialLines);
  const [messages, setMessages] = useState<ChatMessage[]>(props.resumeMessages);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const addLines = useCallback((pending: PendingLine[]) => {
    const next: Line[] = pending.map(([kind, text, meta]) => {
      const line: Line = { id: idRef.current++, kind, text };
      if (meta) line.meta = meta;
      return line;
    });
    setLines((prev) => [...prev, ...next]);
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || busy) return;
      setInput("");
      setBusy(true);
      setStatus("thinking …");
      addLines([["user", content]]);
      const transcript: ChatMessage[] = [...messages, { role: "user", content }];
      setMessages(transcript);
      try {
        const result = await runAgentLoop({
          model: props.model,
          messages: transcript,
          ...(props.tools !== undefined ? { tools: props.tools } : {}),
          executeTool: props.executeTool,
          ...(props.maxTurns !== undefined ? { maxTurns: props.maxTurns } : {}),
          ...(props.tokenBudget !== undefined ? { tokenBudget: props.tokenBudget } : {}),
          ...(props.temperature !== undefined ? { temperature: props.temperature } : {}),
          ...(props.numContext !== undefined ? { numContext: props.numContext } : {}),
          onAssistantMessage: (msg) => {
            const pending: PendingLine[] = [];
            if (msg.content) pending.push(["assistant", msg.content]);
            for (const call of msg.toolCalls ?? []) pending.push(["toolCall", formatToolCall(call)]);
            if (pending.length > 0) addLines(pending);
          },
          onToolResult: (_call, result, ok) => {
            const { text, meta } = summarizeToolResult(result, ok);
            addLines([["toolResult", text, meta]]);
          },
        });
        setMessages(result.messages);
        setStatus(
          `${result.stopReason} · ${result.turns} turn(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
            (props.sessionId ? ` · session ${props.sessionId}` : ""),
        );
        props.onTurnEnd?.(result);
      } catch (err) {
        addLines([["error", `loop failed: ${err instanceof Error ? err.message : String(err)}`]]);
        setStatus("error — type a message and press Enter to retry");
      } finally {
        setBusy(false);
      }
    },
    [messages, busy, addLines, props],
  );

  useInput((raw, key) => {
    if (key.return) {
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    setInput((prev) => prev + raw);
  });

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => {
          const color = colorFor(line.kind);
          return (
            <Text key={line.id} {...(color ? { color } : {})}>
              {prefixFor(line.kind)}
              {line.text}
              {line.meta ? " " : ""}
              {line.meta ? <Text dimColor>{line.meta}</Text> : null}
            </Text>
          );
        }}
      </Static>
      <Box marginTop={1}>
        <Text color={busy ? "yellow" : "green"}>{busy ? "…" : "❯"}</Text>
        <Text>
          {busy ? ` ${status}` : ` ${input || status}`}
          {busy ? "" : <Text dimColor>█</Text>}
        </Text>
      </Box>
      {lines.length === 0 && !busy ? (
        <Box>
          <Text dimColor>type a message and press Enter · Ctrl+C to quit</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export type StartChatOptions = Omit<ChatAppProps, "resumeMessages"> & { resumeMessages: ChatMessage[] };

/** Render the interactive chat and resolve when the user quits. */
export async function startChat(options: StartChatOptions): Promise<void> {
  const { render } = await import("ink");
  await render(<ChatApp {...options} />).waitUntilExit();
}