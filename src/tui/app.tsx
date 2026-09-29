import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useInput } from "ink";
import { runAgentLoop } from "../agent/loop.js";
import type {
  AgentLoopCheckpointOptions,
  AgentLoopCompactionOptions,
  AgentLoopHookOptions,
  AgentLoopResult,
  CompactionNotice,
} from "../agent/loop.js";
import type { ChatMessage, ResolvedModel, ToolCall, ToolDef } from "../providers/types.js";
import { estimateMessageTokens } from "../agent/budget.js";
import { clip, expandMarkdown, formatTokens, formatToolCall, linesFromMessages, summarize, toolResultBody } from "./render.js";
import { COMMANDS, deleteToStart, deleteWordBack, helpText, isCommand, isKnownCommand, matchingCommands, parseCommand, walkHistory } from "./commands.js";
import { LineView, StatusBar } from "./components.jsx";
import type { Line, LineKind } from "./render.js";
import type { Skill } from "../skills/types.js";
import { matchSkills, skillContext } from "../skills/index.js";
import { loadSession } from "../agent/session.js";
import { listCheckpoints } from "../checkpoint/store.js";
import { listForkableTurns } from "../checkpoint/fork.js";
import { restoreToTurn as restoreCheckpointToTurn } from "../checkpoint/restore.js";
import { isReadOnlyTool, resolveDecision, resolveEngine } from "../permissions/index.js";
import type { CheckpointEntry } from "../checkpoint/store.js";
import type { ToolContext } from "../tools/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { Session } from "../agent/session.js";
import type { CheckpointDisplayInfo } from "../checkpoint/types.js";

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
  /**
   * Asked to quit. Supplied by the host, which owns the process: a test renders
   * the component with no terminal to close, and a component that called
   * `process.exit` would take the test runner with it.
   */
  onExit?: () => void;
  /**
   * Whether the prompt should accept keystrokes, default true.
   *
   * Ink mounts a raw-mode input handler for anything that calls `useInput`, and
   * on a host with no raw-mode stdin that handler throws. `jaa chat` already
   * refuses to start without a TTY, so this is only a switch for a host that
   * renders the component deliberately — a test, or an embedder with its own
   * input handling. It is not a substitute for that guard.
   */
  interactive?: boolean;
  /** Pre-loaded skills for autotrigger. When a user message matches a skill's
      triggers, the skill body is injected as a system message before the
      model call. */
  skills?: Skill[];
  /**
   * Take any compiler reports collected so far, for the user's eyes.
   *
   * A drain rather than a push, and that is a consequence of ordering rather
   * than a preference: the host's diagnostics wrapper is built before this
   * component exists and runs during tool calls, so a report can be produced
   * before anyone is listening. A callback would drop exactly those. Draining
   * after each tool result cannot.
   *
   * Optional and independent of the model. The diagnostics still ride on the
   * tool result, so they reach the model and the saved session whether or not
   * this is supplied; this only adds transcript rows, and as a row of its own —
   * so "the compiler found 3 problems" cannot be misread as the model reporting
   * on its own work.
   */
  drainDiagnostics?: () => { text: string; path: string }[];
  /**
   * Phase 13 hook wiring, handed to `runAgentLoop` untouched.
   *
   * Optional, and absent rather than empty by default: the loop builds no hook
   * wiring at all unless this property is present, so a host that configures no
   * hook takes the same path it took before Phase 13. The host owns the entries
   * — the CLI builds them with the same loader and the same
   * `--trust-project-settings` opt-in `jaa ask` uses — so the TUI cannot
   * disagree with the one-shot path about which hooks are in force.
   */
  hooks?: AgentLoopHookOptions;
  /**
   * Phase 14 checkpoint wiring: the session the snapshots belong to, and the
   * root every snapshot path is confined to.
   *
   * Optional for the same reason `hooks` is. It needs a session id to name a
   * store, so a host with nothing to save omits it and nothing is snapshotted,
   * which is also why a rewind needs `--save` to have anything to rewind.
   */
  checkpoints?: AgentLoopCheckpointOptions;
  /**
   * Phase 16: summarise the context when it outgrows the budget. Optional for
   * the same reason as the others — a host that omits it gets the pre-Phase-16
   * behaviour, where an over-budget request is trimmed rather than summarised.
   */
  compaction?: AgentLoopCompactionOptions;
  // Checkpoint/restore/fork functionality
  onCheckpointState?: (state: CheckpointDisplayInfo | null) => void;
  restoreToTurn?: (turn: number) => Promise<boolean>;
  forkSession?: (targetTurn?: number) => Promise<Session>;
  /**
   * Rewind as a dry run: report what a restore would do and write nothing.
   *
   * Named for what it does here, not after the Phase 14 helper option it
   * resembles. `restoreFilesToTurn`'s `preserveCurrent` guards the stored
   * transcript only — that helper ignores it and writes the working tree either
   * way — so the TUI never calls restore with it set. What the helpers call
   * `reportOnly` is what this is: a preview, which is the only reading that
   * cannot overwrite a file by accident.
   */
  previewOnly?: boolean;
  /** Root a rewind is confined to. Defaults to the process working directory. */
  toolContext?: ToolContext;
  /**
   * The mode the host gated its tool calls with. Passed through to
   * `resolveEngine` so a rewind is decided by the same policy as any other
   * write; omitted, the mode is read from settings exactly as the host read it.
   */
  permissionMode?: PermissionMode;
}

type PendingLine = readonly [kind: LineKind, text: string, meta?: string];

/**
 * How close together two Escape presses must be to count as the `Esc Esc`
 * gesture. Long enough to be deliberate, short enough that a stray second press
 * does not rewind a file.
 */
const ESC_DOUBLE_TAP_MS = 600;

/** The file name alone, for a diagnostics row: the path is already in context. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * One row of the `/rewind` picker.
 *
 * `turn` is the restore target — the state to go back to, in the same
 * 1-based message positions `restoreMessagesToTurn` slices on.
 */
interface RewindRow {
  turn: number;
  /** One line, derived from the messages already in the transcript. */
  summary: string;
  /** Files restoring to this turn would write. */
  files: string[];
}

/** Rows of the picker kept on screen at once, so a long session still fits. */
const PICKER_WINDOW = 12;

interface PickerState {
  rows: RewindRow[];
  /** Which row is focused. Always in range, so navigation cannot go off the end. */
  index: number;
}

interface ConfirmState {
  turn: number;
  row: RewindRow;
  /** Files the restore would rewrite, and messages it would drop. */
  files: string[];
  dropped: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A one-line description of what turn `turn` did, taken from the transcript the
 * turn is a position in. No model is consulted: the nearest user message at or
 * before the turn is the prompt that caused it, and the file list comes from
 * the checkpoint metadata that already exists.
 */
function turnSummary(session: Session, turn: number, files: readonly string[]): string {
  const messages = session.messages;
  for (let i = Math.min(turn, messages.length) - 1; i >= 0; i--) {
    const message = messages[i];
    if (message !== undefined && message.role === "user" && message.content.trim() !== "") {
      return summarize(message.content, 60);
    }
  }
  return files.length > 0 ? `${files.length} file(s) changed` : "no prompt on record";
}

/**
 * The files a restore to `targetTurn` would rewrite, display only.
 *
 * Mirrors the store's own rule — the earliest snapshot after the target turn
 * per file — so the confirmation names exactly the files the write touches. It
 * reads the checkpoint list rather than calling restore, because restore's
 * `preserveCurrent` guards the transcript only: it would have written the
 * working tree to produce a list.
 */
function filesRewrittenBy(checkpoints: readonly CheckpointEntry[], targetTurn: number): string[] {
  const chosen = new Map<string, number>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.turn <= targetTurn) continue;
    const current = chosen.get(checkpoint.file);
    if (current === undefined || checkpoint.turn < current) chosen.set(checkpoint.file, checkpoint.turn);
  }
  return [...chosen.keys()].sort();
}

/** The context a rewind is confined to when the host did not supply one. */
function rewindContext(): ToolContext {
  return { root: process.cwd(), cwd: process.cwd(), allowBash: false };
}

/**
 * Decide a rewind as the Phase 11 engine decides any other write.
 *
 * A rewind is a `write_file` per file, so it goes through the same engine, the
 * same rules and the same mode as the writes the agent itself makes. A deny is
 * final and refuses the whole rewind; an `ask` is answered by the confirmation
 * panel below, which is also why the panel is shown even when the decision
 * already allows — a rewind overwrites work the operator may not have saved.
 */
function authorizeRewind(
  files: readonly string[],
  ctx: ToolContext,
  mode: PermissionMode | undefined,
): { ok: true } | { ok: false; reason: string } {
  const policy = resolveEngine({ ...(mode !== undefined ? { mode } : {}) });
  for (const file of files) {
    const outcome = policy.engine.evaluate({
      tool: "write_file",
      args: { path: file },
      cwd: ctx.cwd,
      root: ctx.root,
    });
    if (resolveDecision(outcome, policy.mode, isReadOnlyTool("write_file"), "write_file") === "deny") {
      return { ok: false, reason: outcome.reason };
    }
  }
  return { ok: true };
}

export function ChatApp(props: ChatAppProps): React.JSX.Element {
  // The turn the transcript is currently at, and a counter that changes whenever
  // the checkpoints on disk may have too. The effect below reads both: without
  // the counter it would report the coverage the session had at mount, when the
  // agent had not yet written anything.
  const [currentTurn, setCurrentTurn] = useState(0);
  const [checkpointEpoch, setCheckpointEpoch] = useState(0);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const escTapRef = useRef<number | null>(null);

  // Report checkpoint coverage to the host as the session changes.
  // `loadSession` is synchronous and returns undefined for an unknown id, so
  // there is nothing to await; the parent owns the state, not this component.
  // A session that no longer reads is reported as no coverage rather than
  // thrown out of a render, since this now re-runs after every turn.
  useEffect(() => {
    if (!props.sessionId) {
      props.onCheckpointState?.(null);
      return;
    }
    let session: Session | undefined;
    try {
      session = loadSession(props.sessionId);
    } catch {
      session = undefined;
    }
    if (!session) {
      props.onCheckpointState?.(null);
      return;
    }
    const checkpoints = listCheckpoints(session);
    const turns = checkpoints.map((cp) => cp.turn);
    props.onCheckpointState?.({
      total: checkpoints.length,
      currentTurn: Math.max(currentTurn, ...turns, 1),
      oldestTurn: Math.min(...turns, 1),
      newestTurn: Math.max(...turns, 1),
      filesAffected: [...new Set(checkpoints.map((cp) => cp.file))].length,
    });
  }, [props.sessionId, props.onCheckpointState, currentTurn, checkpointEpoch]);

  const initialMessages = useMemo(() => {
    if (props.resumeMessages.length > 0) return props.resumeMessages;
    return [{ role: "system" as const, content: props.systemPrompt }];
  }, [props.resumeMessages, props.systemPrompt]);
  const initialLines = useMemo(() => linesFromMessages(initialMessages), [initialMessages]);
  const idRef = useRef(initialLines.length);
  /**
   * Rows that are finished and will never change again. Rendered in `Static`,
   * which paints each row exactly once and hands the terminal back.
   */
  const [lines, setLines] = useState<Line[]>(initialLines);
  /**
   * Rows that are still changing: the assistant's streaming text, and the tool
   * card currently running.
   *
   * These cannot go in `Static`. A `Static` item is written to the terminal once
   * and never repainted, so a row that grows — one token at a time, or a tool
   * card that changes from running to a verdict — would be painted as a new row
   * per update and stack up on screen. Keeping the moving parts in ordinary
   * state is what lets one row be updated in place. They are committed to
   * `lines` when the turn ends.
   */
  const [live, setLive] = useState<Line[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [caret, setCaret] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  /**
   * Whether the prompt can take keys.
   *
   * Supplied by the host rather than sniffed here, because Ink's own capability
   * check is the authority — it is the thing that throws if this answer is
   * wrong. `startChat` reads it from Ink and passes it down; a test renders with
   * its own input stream and says what that stream can do.
   *
   * Default true, so a host that passes nothing gets the input-enabled TUI and
   * the same behaviour as before.
   */
  const interactive = props.interactive ?? true;
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [draft, setDraft] = useState("");
  const [ticks, setTicks] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0 });
  const [turns, setTurns] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  /**
   * Set while the operator is looking at a tool card, so Ctrl+R knows what it is
   * toggling.
   *
   * The expansion itself lives in the card's own state; this only remembers
   * which card Ctrl+R was last pressed for, because a finished card has been
   * committed to `Static` and can no longer be re-rendered by changing it there.
   */
  const [focusedCard, setFocusedCard] = useState<number | null>(null);

  const exit = useCallback(() => {
    props.onExit?.();
  }, [props]);

  /** The running tool card's row id, so a result patches the right row. */
  const runningToolRef = useRef<number | null>(null);
  const toolStartedRef = useRef(0);
  /** The assistant text painted so far this turn. */
  const streamTextRef = useRef("");
  /** The first row id of the streamed message, or null before its first delta. */
  const streamRowRef = useRef<number | null>(null);
  /** How many transcript rows the streamed message currently occupies. */
  const streamCountRef = useRef(0);

  const addLines = useCallback((pending: PendingLine[]) => {
    const next: Line[] = pending.map(([kind, text, meta]) => {
      const line: Line = { id: idRef.current++, kind, text };
      if (meta) line.meta = meta;
      return line;
    });
    setLines((prev) => [...prev, ...next]);
  }, []);

  /**
   * A tool card, added in the `running` state and updated in place.
   *
   * It lives in `live` rather than `lines` for as long as it is running, and is
   * committed when it finishes. A card is something the operator watches rather
   * than reads past, so it must be able to change from "running" to a verdict
   * on the same line.
   */
  const startToolCard = useCallback((call: ToolCall) => {
    const id = idRef.current++;
    runningToolRef.current = id;
    toolStartedRef.current = Date.now();
    setLive((prev) => [
      ...prev,
      {
        id,
        kind: "toolCall",
        text: formatToolCall(call),
        tool: { name: call.name, args: clip(call.arguments, 140), state: "running", expanded: false },
      },
    ]);
  }, []);

  const finishToolCard = useCallback((_call: ToolCall, result: string, ok: boolean) => {
    const id = runningToolRef.current;
    if (id === null) return;
    runningToolRef.current = null;
    const elapsedMs = Date.now() - toolStartedRef.current;
    setLive((prev) => {
      const next = prev.map((line) => {
        if (line.id !== id || line.tool === undefined) return line;
        return {
          ...line,
          tool: {
            ...line.tool,
            // Narrowed to the literal union, not `string`, so the card's state
            // stays one of the three things a reader can be told.
            state: ok ? ("ok" as const) : ("failed" as const),
            elapsedMs,
            result: toolResultBody(result, false),
          },
        };
      });
      // The card has stopped changing, so it can be handed to `Static`.
      setLines((committed) => [...committed, ...next.filter((line) => line.id === id)]);
      return next.filter((line) => line.id !== id);
    });
  }, []);

  const toggleToolCard = useCallback(() => {
    const flip = (row: Line): Line => {
      if (row.tool === undefined || row.tool.result === undefined) return row;
      const expanded = !row.tool.expanded;
      setFocusedCard(row.id);
      return { ...row, tool: { ...row.tool, expanded, result: toolResultBody(row.tool.result, expanded) } };
    };
    // The remembered card first, so a second Ctrl+R collapses the same card
    // rather than hunting for a newer one. Then the most recent, because with
    // nothing remembered the operator means the newest tool.
    const target = focusedCard;
    if (target !== null) {
      const applied = (rows: Line[]): Line[] | undefined => {
        const index = rows.findIndex((row) => row.id === target);
        if (index === -1) return undefined;
        const next = [...rows];
        const flipped = next[index];
        if (flipped === undefined) return undefined;
        next[index] = flip(flipped);
        return next;
      };
      const inLive = applied(live);
      if (inLive !== undefined) {
        setLive(inLive);
        return;
      }
      const inLines = applied(lines);
      if (inLines !== undefined) {
        setLines(inLines);
        return;
      }
    }
   // Nothing remembered, so the operator means the newest card — which is in
   // whichever list it was left in. The list is chosen here rather than by
   // trying each in turn, because a state updater that finds nothing still
   // "succeeds" and would stop the search before it reached the right list.
   const newestIn = (rows: Line[]): Line | undefined => {
   for (let i = rows.length - 1; i >= 0; i--) {
   const row = rows[i];
   if (row !== undefined && row.tool !== undefined && row.tool.result !== undefined) return row;
   }
   return undefined;
   };
   const newest = newestIn(live) ?? newestIn(lines);
   if (newest === undefined) return;
   if (live.some((row) => row.id === newest.id)) {
   setLive((prev) => prev.map((row) => (row.id === newest.id ? flip(row) : row)));
   return;
   }
   setLines((prev) => prev.map((row) => (row.id === newest.id ? flip(row) : row)));
  }, [focusedCard, live, lines]);

  /** Re-render while a turn runs, so the elapsed timer advances. */
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 250);
    setTicks((n) => n + 1);
    return () => clearInterval(timer);
  }, [busy]);

  /**
   * Paint a streamed fragment.
   *
   * One row is reused for the whole message rather than a row per delta. A row
   * per fragment would put thousands of rows in a `Static` list that never
   * repaints, so the first delta creates the row and every later one replaces
   * its text. The row is re-expanded through `expandMarkdown`, so a code fence
   * typed halfway through renders as code as soon as its closing fence arrives.
   */
  const appendDelta = useCallback((delta: string) => {
    streamTextRef.current += delta;
    const text = streamTextRef.current;
    const first = streamRowRef.current;
    setLive((prev) => {
      const expanded = expandMarkdown(text, first ?? idRef.current);
      if (expanded.length === 0) return prev;
      if (first === null) {
        streamRowRef.current = expanded[0]?.id ?? null;
        streamCountRef.current = expanded.length;
        idRef.current += expanded.length;
        return [...prev, ...expanded];
      }
      // Replace exactly the rows the previous expansion produced, which are the
      // last `streamCount` of them. Slicing on the recorded count rather than
      // searching for ids is what keeps this correct when a delta adds or
      // removes a row — a closed code fence changes the row count mid-stream.
      const count = streamCountRef.current;
      const head = prev.length - count;
      if (head < 0) return prev;
      streamCountRef.current = expanded.length;
      idRef.current += expanded.length - count;
      return [...prev.slice(0, head), ...expanded, ...prev.slice(head + count)];
    });
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const content = raw.trim();
      if (!content || busy) return;
      setInput("");
      setCaret(0);
      setQuitArmed(false);
      setBusy(true);
      setStatus("thinking …");
      setNotice(undefined);
      streamTextRef.current = "";
      streamRowRef.current = null;
      streamCountRef.current = 0;
      // The draft is only saved once the prompt is accepted, so walking history
      // back with ↑ does not fill the box with half-typed junk.
      setDraft("");
      setHistory((prev) => (prev[prev.length - 1] === content ? prev : [...prev, content]));
      setHistoryIndex(0);
      addLines([["user", content]]);
      const matched = props.skills ? matchSkills(props.skills, content) : [];
      const skillCtx = matched.length > 0 ? skillContext(matched) : "";
      if (matched.length > 0) {
        addLines([["assistant", `[skills] ${matched.map((s) => s.name).join(", ")}`]]);
      }
      const extra: ChatMessage[] = skillCtx ? [{ role: "system", content: skillCtx }] : [];
      const transcript: ChatMessage[] = [...messages, ...extra, { role: "user", content }];
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
          // Paint as the text arrives. The adapter is asked for a stream only
          // because this is set, and the loop falls back to a single call when
          // the provider has no stream — so a provider that cannot stream still
          // works, just without the effect.
          onStreamDelta: (delta) => {
            appendDelta(delta);
          },
          // A turn whose stream died is re-run, and the retry is announced as a
          // replacement. Without this the transcript would read the partial text
          // followed by the whole one.
          onStreamReplace: (text) => {
            streamTextRef.current = text;
            const first = streamRowRef.current;
            setLive((prev) => {
              if (first === null) {
                const expanded = expandMarkdown(text, idRef.current);
                if (expanded.length === 0) return prev;
                streamRowRef.current = expanded[0]?.id ?? null;
                idRef.current += expanded.length;
                streamCountRef.current = expanded.length;
                return [...prev, ...expanded];
              }
              const count = streamCountRef.current;
              const head = prev.length - count;
              if (head < 0) return prev;
              const expanded = expandMarkdown(text, first);
              idRef.current += expanded.length - count;
              streamCountRef.current = expanded.length;
              return [...prev.slice(0, head), ...expanded, ...prev.slice(head + count)];
            });
          },
          onToolCall: (call) => {
            startToolCard(call);
          },
          onAssistantMessage: (msg) => {
            // A streamed message has already been painted row by row, and adding
            // it again would duplicate the whole reply. Only a message that never
            // streamed — the fallback path, or a tool-call round with no text —
            // needs a row here.
            if (msg.content !== "" && streamTextRef.current === "") {
              const expanded = expandMarkdown(msg.content, idRef.current);
              idRef.current += expanded.length;
              addLines(expanded.map((row) => [row.kind, row.text, row.meta] as PendingLine));
            }
            // The message is finished, so its rows stop changing and can be
            // handed to `Static`. Anything still running in `live` — a later tool
            // card — is left alone.
            const count = streamCountRef.current;
            if (count > 0) {
              setLive((prev) => {
                const head = prev.length - count;
                if (head < 0) return prev;
                const finished = prev.slice(head, head + count);
                setLines((committed) => [...committed, ...finished]);
                return [...prev.slice(0, head), ...prev.slice(head + count)];
              });
            }
            streamTextRef.current = "";
            streamRowRef.current = null;
            streamCountRef.current = 0;
          },
          onToolResult: (call, result, ok) => {
            finishToolCard(call, result, ok);
            // Drained here, after the tool result that caused it. A report with
            // no text means the file is clean, and saying so on every write
            // would be noise.
            for (const report of props.drainDiagnostics?.() ?? []) {
              if (report.text === "") continue;
              addLines([["diagnostic", report.text, basename(report.path)]]);
            }
          },
          /**
           * The compiler's verdict on a file the agent just wrote, as its own row.
           *
           * `withDiagnostics` also appends it to the tool result, so it reaches
           * the model and the saved session either way. This is for the *user*:
           * the model saying "done" and the compiler disagreeing is the single
           * most important thing to see in this transcript, and it has to be
           * visually distinct from both, or it reads as something the model said
           * about its own work.
           */
          // The compiler's verdict, drawn as its own row. Drained after the tool
          // result it belongs to, so a report produced while this component was
          // still mounting is not lost.
          ...(props.drainDiagnostics !== undefined ? { onDiagnostics: props.drainDiagnostics } : {}),
          // Present only when the host supplied them, never as an empty object:
          // `runAgentLoop` reads `hooks === undefined` and `checkpoints ===
          // undefined` to decide there is no wiring, so an absent property is
          // what keeps a hookless, checkpointless TUI on the pre-Phase-13/14
          // path. Compaction follows the same rule.
          ...(props.hooks !== undefined ? { hooks: props.hooks } : {}),
          ...(props.checkpoints !== undefined ? { checkpoints: props.checkpoints } : {}),
          ...(props.compaction !== undefined ? { compaction: props.compaction } : {}),
          // A compaction marker goes into the transcript, not just the status
          // line: the context the model is reasoning over just changed, and a
          // user reading back through the session needs to see where.
          ...(props.compaction !== undefined
            ? {
                onCompaction: (info: CompactionNotice) => {
                  addLines([
                    [
                      "compact",
                      `context compacted: ${info.tokensBefore} → ${info.tokensAfter} tokens`,
                      `${info.calls} summarising call${info.calls === 1 ? "" : "s"}`,
                    ],
                  ]);
                },
              }
            : {}),
        });
        setMessages(result.messages);
        setCurrentTurn(result.turnIndex ?? result.messages.length);
        setCheckpointEpoch((epoch) => epoch + 1);
        setUsage(result.usage);
        setTurns((n) => n + result.turns);
        setStatus(
          `${result.stopReason} · ${result.turns} turn(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
        );
        props.onTurnEnd?.(result);
      } catch (err) {
        addLines([["error", `loop failed: ${errorText(err)}`]]);
        setStatus("error — type a message and press Enter to retry");
      } finally {
        streamTextRef.current = "";
        streamRowRef.current = null;
        streamCountRef.current = 0;
        setBusy(false);
      }
    },
    [messages, busy, addLines, props, appendDelta, startToolCard, finishToolCard],
  );

  // --- rewind ---------------------------------------------------------------

  /** The saved session a rewind addresses, or undefined when there is none. */
  const sessionForRewind = useCallback((): Session | undefined => {
    if (!props.sessionId) return undefined;
    return loadSession(props.sessionId);
  }, [props.sessionId]);

  const openPicker = useCallback(() => {
    let session: Session | undefined;
    try {
      session = sessionForRewind();
    } catch (err) {
      addLines([["error", `rewind failed: ${errorText(err)}`]]);
      return;
    }
    if (!session) {
      setStatus("rewind needs a saved session — start chat with --save");
      return;
    }
    const rows = rewindRows(session);
    if (rows.length === 0) {
      addLines([["assistant", "no checkpoints yet — the agent has not written a file this session"]]);
      return;
    }
    setPicker({ rows, index: 0 });
  }, [sessionForRewind, addLines]);

  /**
   * Everything that has to be true before a single byte is written: the
   * session exists, the target is real, the permission engine allows it, and —
   * unless this is a preview — the operator has confirmed.
   */
  const beginRewind = useCallback(
    (turn: number) => {
      if (busy) {
        setStatus("wait for the turn to finish before rewinding");
        return;
      }
      let session: Session;
      try {
        const found = sessionForRewind();
        if (!found) {
          setStatus("rewind needs a saved session — start chat with --save");
          return;
        }
        session = found;
      } catch (err) {
        addLines([["error", `rewind failed: ${errorText(err)}`]]);
        return;
      }

      const checkpoints = listCheckpoints(session);
      const files = filesRewrittenBy(checkpoints, turn);
      const dropped = Math.max(0, session.messages.length - turn);
      const decision = authorizeRewind(files, props.toolContext ?? rewindContext(), props.permissionMode);
      if (!decision.ok) {
        addLines([["error", `rewind to turn ${turn} refused: ${decision.reason}`]]);
        return;
      }

      if (props.previewOnly === true) {
        addLines([["assistant", previewText(turn, files, dropped)]]);
        return;
      }

      const row = rowsFor(session, turn)[0] ?? { turn, summary: `rewind to turn ${turn}`, files };
      setConfirm({ turn, row, files, dropped });
    },
    [busy, sessionForRewind, addLines, props],
  );

  /** Records a completed rewind in the transcript and refreshes coverage. */
  const announceRewind = useCallback(
    (turn: number, restored?: number) => {
      setCurrentTurn(turn);
      setCheckpointEpoch((epoch) => epoch + 1);
      const files = restored === undefined ? "" : ` · ${restored} file(s) restored`;
      // The rewound transcript a terminal cannot unprint stays on screen; the
      // model gets the rewound one, and this marker says which is which.
      addLines([["assistant", `⟲ rewound to turn ${turn}${files}`]]);
    },
    [addLines],
  );

  /** Runs only after an explicit `y`. */
  const applyRewind = useCallback(
    async (turn: number) => {
      const ctx = props.toolContext ?? rewindContext();
      try {
        if (props.restoreToTurn) {
          const ok = await props.restoreToTurn(turn);
          if (!ok) {
            addLines([["error", `rewind to turn ${turn} did not complete`]]);
            return;
          }
          setMessages(messages.slice(0, turn));
          announceRewind(turn);
          return;
        }

        const session = sessionForRewind();
        if (!session) {
          addLines([["error", "rewind failed: the session is no longer on disk"]]);
          return;
        }
        // `preserveCurrent: false` is the point of the confirmation: the stored
        // transcript is rewritten to the target turn. Every file write is
        // confined to `ctx.root` by the helper itself.
        const result = restoreCheckpointToTurn(session, turn, ctx, { preserveCurrent: false });
        for (const error of result.errors) addLines([["error", error]]);
        if (!result.success) {
          addLines([["error", `rewind to turn ${turn} did not complete`]]);
          return;
        }
        setMessages(messages.slice(0, turn));
        announceRewind(turn, result.files.restored.length);
      } catch (err) {
        addLines([["error", `rewind failed: ${errorText(err)}`]]);
      }
    },
    [messages, props, sessionForRewind, addLines, announceRewind],
  );

  /**
   * The newest rewind target: the state just before the most recent write, or
   * the reason there is not one.
   *
   * A snapshot tagged turn T precedes the write of turn T, so the state it
   * holds is the one as of T-1 — the same offset the picker's rows use.
   */
  const rewindTarget = useCallback((): { turn: number } | { none: string } => {
    let session: Session | undefined;
    try {
      session = sessionForRewind();
    } catch (err) {
      return { none: `rewind failed: ${errorText(err)}` };
    }
    if (!session) return { none: "rewind needs a saved session — start chat with --save" };
    const turns = listCheckpoints(session).map((cp) => cp.turn);
    if (turns.length === 0) return { none: "no checkpoints yet — nothing to rewind" };
    return { turn: Math.max(...turns) - 1 };
  }, [sessionForRewind]);

  /**
   * A slash command, handled entirely inside jaa.
   *
   * Returns true when the line was a command, so the caller knows not to send it
   * to the model. An unknown `/foo` is a command *attempt* and is reported as
   * such rather than forwarded: a leading slash is a clear statement of intent,
   * and quietly spending a model call on a typo is the worst outcome here.
   */
  const runCommand = useCallback(
    (line: string): boolean => {
      if (!isCommand(line)) return false;
      const parsed = parseCommand(line);
      if (parsed === undefined) return false;

      if (!isKnownCommand(parsed.name)) {
        const known = COMMANDS.map((c) => c.name).join(" ");
        setNotice(`unknown command ${parsed.name}. try: ${known}`);
        return true;
      }
      setNotice(undefined);

      switch (parsed.name) {
        case "/help":
          addLines([["notice", helpText()]]);
          return true;
        case "/rewind":
          openPicker();
          return true;
        case "/model":
          addLines([["notice", `answering with ${props.model.provider}/${props.model.model}`]]);
          return true;
        case "/tokens":
          addLines([
            [
              "notice",
              `${formatTokens(usage.inputTokens)} in / ${formatTokens(usage.outputTokens)} out over ${turns} turn(s)`,
            ],
          ]);
          return true;
        case "/sessions":
          addLines([["notice", props.sessionId ?? "no session id — start with --save to keep one"]]);
          return true;
        case "/clear":
          // Keep the conversation, drop the rows. A `Static` list has already
          // painted, so this genuinely cannot scroll them away; what it does is
          // stop the transcript growing, and the next row starts clean.
          setLines([]);
          setLive([]);
          idRef.current = 0;
          streamRowRef.current = null;
          streamCountRef.current = 0;
          runningToolRef.current = null;
          setNotice("screen cleared — the conversation is unchanged");
          return true;
        case "/new":
          setLines([]);
          setLive([]);
          idRef.current = 0;
          streamRowRef.current = null;
          streamCountRef.current = 0;
          runningToolRef.current = null;
          setMessages([{ role: "system", content: props.systemPrompt }]);
          setTurns(0);
          setUsage({ inputTokens: 0, outputTokens: 0 });
          setNotice("started a fresh conversation");
          return true;
        case "/exit":
          setNotice("use Ctrl+D or Ctrl+C twice to quit");
          return true;
        default:
          // Unreachable: `isKnownCommand` gated the switch. Present so a new
          // command cannot fall through as a silent no-op.
          setNotice(`${parsed.name} is not wired up yet`);
          return true;
      }
    },
    [addLines, openPicker, props.model, props.sessionId, props.systemPrompt, usage, turns],
  );

  // One input handler for every mode. A second `useInput` would race this one
  // for the same keypress.
  //
  // `isActive` is what stops Ink from mounting a raw-mode handler on a host that
  // has none. Without it, rendering into a pipe or a harness throws from inside
  // Ink's own effect — a stack trace printed over the operator's prompt, with no
  // indication of what to do about it.
  useInput(
    (raw, key) => {
    if (key.ctrl && raw === "c") {
      // Ctrl+C twice, so a stray interrupt during a long turn does not throw
      // away a conversation. The first press says so rather than doing nothing
      // silently, which would leave the operator unsure whether it registered.
      if (quitArmed) {
        exit();
        return;
      }
      setQuitArmed(true);
      setNotice("press Ctrl+C again to quit");
      return;
    }
    if (key.ctrl && raw === "d") {
      exit();
      return;
    }
    if (key.ctrl && raw === "r") {
      // A card is only held back from `Static` once it has been expanded, so the
      // first press flips the newest card and remembers it; from then on that
      // same card is the one that collapses.
      toggleToolCard();
      return;
    }
    if (quitArmed && !key.ctrl) {
      // Any other key disarms, so the second Ctrl+C has to be deliberate and
      // adjacent in time to the first.
      setQuitArmed(false);
      setNotice(undefined);
    }

    if (confirm !== null) {
      if (raw === "y" || raw === "Y") {
        setConfirm(null);
        void applyRewind(confirm.turn);
        return;
      }
      if (raw === "n" || raw === "N" || key.escape || key.return) {
        setConfirm(null);
        addLines([["assistant", `rewind to turn ${confirm.turn} cancelled`]]);
        return;
      }
      // Anything else is ignored: a rewind must never be triggered by a key the
      // operator pressed while reaching for another one.
      return;
    }

    if (picker !== null) {
      if (key.upArrow) {
        setPicker((state) => (state === null ? null : { ...state, index: Math.max(0, state.index - 1) }));
        return;
      }
      if (key.downArrow) {
        setPicker((state) =>
          state === null ? null : { ...state, index: Math.min(state.rows.length - 1, state.index + 1) },
        );
        return;
      }
      if (key.return) {
        const target = picker.rows[picker.index];
        setPicker(null);
        if (target) beginRewind(target.turn);
        return;
      }
      if (key.escape || raw === "q") {
        setPicker(null);
        return;
      }
      return;
    }

    if (key.escape) {
      const now = Date.now();
      const previous = escTapRef.current;
      escTapRef.current = null;
      if (previous !== null && now - previous <= ESC_DOUBLE_TAP_MS) {
        const target = rewindTarget();
        if ("none" in target) {
          setStatus(target.none);
          return;
        }
        beginRewind(target.turn);
        return;
      }
      escTapRef.current = now;
      setStatus("Esc again within a moment to rewind the last edit");
      return;
    }

    if (key.upArrow) {
      const moved = walkHistory(history, historyIndex, draft, "older");
      setInput(moved.text);
      setCaret(moved.text.length);
      setHistoryIndex(moved.index);
      return;
    }
    if (key.downArrow) {
      const moved = walkHistory(history, historyIndex, draft, "newer");
      setInput(moved.text);
      setCaret(moved.text.length);
      setHistoryIndex(moved.index);
      return;
    }

    if (key.ctrl && raw === "w") {
      const next = deleteWordBack(input, caret);
      setInput(next.text);
      setCaret(next.caret);
      return;
    }
    if (key.ctrl && raw === "u") {
      const next = deleteToStart(input, caret);
      setInput(next.text);
      setCaret(next.caret);
      return;
    }

    if (key.return) {
      const line = input.trim();
      setDraft(input);
      // Commands are handled here rather than by the model, so they never reach
      // a provider. Every other line is a prompt, exactly as before.
      if (runCommand(line)) {
        setInput("");
        setCaret(0);
        return;
      }
      void submit(input);
      return;
    }
    if (key.leftArrow) {
      setCaret((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCaret((c) => Math.min(input.length, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (key.delete) {
        setInput((prev) => (caret < prev.length ? prev.slice(0, caret) + prev.slice(caret + 1) : prev));
        return;
      }
      if (caret <= 0) return;
      setInput((prev) => prev.slice(0, caret - 1) + prev.slice(caret));
      setCaret((c) => Math.max(0, c - 1));
      return;
    }
    if (raw === "") return;
    setInput((prev) => prev.slice(0, caret) + raw + prev.slice(caret));
    setCaret((c) => c + raw.length);
    },
    { isActive: interactive },
  );

  const panelOpen = picker !== null || confirm !== null;
  const palette = panelOpen ? [] : matchingCommands(parseCommand(input)?.name ?? "");

  /**
   * The input line, split around the caret so a cursor anywhere in the text
   * draws in the right place.
   *
   * Ink has no cursor primitive, so the block is always drawn at the caret and
   * the line is assembled around it. When the line is longer than the terminal
   * is wide, a line scrolled past the right edge would push the block off
   * screen, so the window follows the caret.
   */
  const { before, highlighted, after } = useMemo(() => {
    const at = Math.min(caret, input.length);
    const raw = input.slice(at) + (busy ? "" : "█");
    if (busy) return { before: input.slice(0, at), highlighted: "", after: raw };
    return { before: input.slice(0, at), highlighted: "█", after: input.slice(at) };
  }, [input, caret, busy]);

  /**
   * Tokens currently in the prompt, for the gauge.
   *
   * Estimated from the transcript rather than taken from the last turn's
   * `input_tokens`, because the gauge is about the next request: after a
   * compaction or a trim the number the model last saw is not the number about
   * to be sent, and the gauge is the thing that warns before trimming bites.
   */
  const contextTokens = useMemo(
    () => messages.reduce((total, message) => total + estimateMessageTokens(message), 0),
    [messages, ticks],
  );

  return (
    <Box flexDirection="column">
      <StatusBar
        provider={props.model.provider}
        model={props.model.model}
        inputTokens={usage.inputTokens}
        outputTokens={usage.outputTokens}
        budget={props.tokenBudget ?? 32_000}
        contextTokens={contextTokens}
        turns={turns}
        elapsedMs={elapsed}
        busy={busy}
        {...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {})}
        {...(notice !== undefined ? { notice } : {})}
      />
      {/*
        A card the operator has expanded stays out of `Static`.

        `Static` writes a row once and never repaints it, so a card handed to it
        cannot be collapsed again — Ctrl+R would change state that the terminal
        no longer reads. The card is therefore only committed once it is done
        being looked at, which is what makes the expand/collapse pair work.
      */}
      <Static items={lines.filter((line) => line.id !== focusedCard)}>
        {(line) => <LineView key={line.id} line={line} />}
      </Static>
      {[
        ...lines.filter((line) => line.id === focusedCard),
        ...live,
      ].map((line) => (
        <LineView key={line.id} line={line} />
      ))}
      {panelOpen ? null : (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column">
            <Box>
              <Text color={busy ? "yellow" : "green"}>{busy ? "◐" : "❯"}</Text>
              <Text>
                {busy ? " " + status : before}
                {busy ? "" : highlighted}
                {busy ? "" : after}
              </Text>
            </Box>
            {/*
              The last outcome, on its own line under an empty prompt.

              It cannot share the prompt line: a bare caret on an empty input is
              invisible next to anything, and a status replacing the caret leaves
              no sign of where to type. Both are needed, so they are stacked.
            */}
            {!busy && input === "" && status !== "" ? <Text dimColor>{"  " + summarize(status, 100)}</Text> : null}
          </Box>
          {palette.length > 0 && input.startsWith("/") ? (
            <Box flexDirection="column" marginLeft={2}>
              {palette.slice(0, 8).map((command) => (
                <Text key={command.name} dimColor>
                  {command.name.padEnd(10)}
                  {command.summary}
                </Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
      {lines.length === 0 && !busy && !panelOpen ? (
        <Box marginTop={1} flexDirection="column">
          {interactive ? (
            <Text dimColor>Enter send · /help for commands · ↑ history · Esc Esc rewind · Ctrl+C×2 quit</Text>
          ) : (
            // Say why nothing can be typed, rather than showing a prompt that
            // silently ignores every key. Someone piping output in gets this.
            <>
              <Text color="yellow">this terminal cannot be typed into — no raw-mode input available</Text>
              <Text dimColor>use `jaa ask &lt;prompt&gt;` for one-shot output</Text>
            </>
          )}
        </Box>
      ) : null}
      {confirm !== null ? <ConfirmPanel state={confirm} /> : null}
      {picker !== null ? <PickerPanel state={picker} /> : null}
    </Box>
  );
}

/** Turns with checkpoints, newest first, each with a one-line summary. */
function rewindRows(session: Session): RewindRow[] {
  return rowsFor(session).reverse();
}

/**
 * The turns a rewind can name, oldest first.
 *
 * A snapshot tagged turn T was taken *before* the write of turn T, and
 * `restoreFilesToTurn` only applies snapshots after the target turn, so the
 * state a snapshot carries is the state as of T-1. A row is therefore that
 * target, not the checkpoint's own turn: picking the turn the operator wants
 * back to has to restore it, and naming it by the turn they chose is what keeps
 * the picker, the confirmation and the helper speaking about the same number.
 */
function rowsFor(session: Session, only?: number): RewindRow[] {
  const checkpoints = listCheckpoints(session);
  return listForkableTurns(session)
    .map((entry) => entry.turn - 1)
    .filter((turn) => only === undefined || turn === only)
    .map((turn) => {
      const files = filesRewrittenBy(checkpoints, turn);
      return { turn, summary: turnSummary(session, turn, files), files };
    });
}

function previewText(turn: number, files: readonly string[], dropped: number): string {
  const written = files.length > 0 ? clip(files.join(", "), 96) : "none";
  return `⟲ preview only: rewinding to turn ${turn} would restore ${files.length} file(s) (${written}) and drop ${dropped} message(s). Nothing was written.`;
}

/**
 * The `/rewind` picker. Fully keyboard driven — up/down move, Enter selects, Esc
 * or `q` leaves — and the focused row is inverted rather than merely marked, so
 * the selection is visible without colour. Only a window of rows is drawn, so a
 * long session still fits on screen with the focused row in view.
 */
function PickerPanel({ state }: { state: PickerState }): React.JSX.Element {
  const from = Math.max(0, Math.min(state.index - Math.floor(PICKER_WINDOW / 2), state.rows.length - PICKER_WINDOW));
  const visible = state.rows.slice(from, from + PICKER_WINDOW);
  const focusTurn = state.rows[state.index]?.turn;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>rewind to a turn</Text>
      {visible.map((row) => {
        const focused = row.turn === focusTurn;
        return (
          <Text key={row.turn} {...(focused ? { inverse: true } : {})}>
            {focused ? "▸ " : "  "}turn {row.turn} · {row.summary}
            {"  "}
            <Text dimColor>
              {row.files.length} file(s){row.files.length > 0 ? `: ${clip(row.files.join(", "), 48)}` : ""}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>↑/↓ move · Enter restores the state as of that turn · Esc cancels</Text>
    </Box>
  );
}

/**
 * The confirmation every rewind passes through.
 *
 * Restore overwrites the working tree, so it is never silent: the files and the
 * number of dropped messages are named, and only an explicit `y` proceeds.
 */
function ConfirmPanel({ state }: { state: ConfirmState }): React.JSX.Element {
  const written = state.files.length > 0 ? clip(state.files.join(", "), 96) : "none";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        rewind to turn {state.turn}?
      </Text>
      <Text dimColor>  {state.row.summary}</Text>
      <Text>
        {"  "}
        {state.files.length} file(s) will be overwritten: {written}
      </Text>
      <Text dimColor>  {state.dropped} message(s) after this turn are dropped from the session</Text>
      <Text>
        confirm? <Text bold>[y]es</Text> / <Text dimColor>[n]o</Text>
      </Text>
    </Box>
  );
}

export type StartChatOptions = Omit<ChatAppProps, "resumeMessages"> & {
  resumeMessages: ChatMessage[];
  /**
   * The input stream Ink listens on. Defaults to `process.stdin`; a host that
   * supplies its own gets the non-fatal path when it cannot do raw mode, instead
   * of Ink throwing because the stream is not the one it hard-codes.
   */
  stdin?: NodeJS.ReadStream;
};

/** Render the interactive chat and resolve when the user quits. */
/**
 * Whether Ink can put this process's stdin into raw mode.
 *
 * Read from the stream Ink will actually use, and by the same test Ink applies
 * internally (`stdin.isTTY`) — Ink 7 throws out of its input handler when that
 * is false, so this is not a judgement call but a description of what will
 * happen. Passing our own `stdin` to `render` also switches Ink to the
 * non-fatal branch of that throw, which is what keeps a piped or captured run
 * from printing a stack trace over its own output.
 */
function rawModeAvailable(stdin: NodeJS.ReadStream = process.stdin): boolean {
  return stdin.isTTY === true;
}

export async function startChat(options: StartChatOptions): Promise<void> {
  const ink = await import("ink");
  const stdin = options.stdin ?? process.stdin;
  const interactive = rawModeAvailable(stdin);
  const instance = ink.render(
    <ChatApp
      {...options}
      interactive={interactive}
      onExit={() => instance.unmount()}
    />,
    { stdin, exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
