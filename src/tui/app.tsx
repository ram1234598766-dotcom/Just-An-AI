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
import { clip, formatToolCall, linesFromMessages, summarize, summarizeToolResult } from "./render.js";
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
  /** Pre-loaded skills for autotrigger. When a user message matches a skill's
      triggers, the skill body is injected as a system message before the
      model call. */
  skills?: Skill[];
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
    // Phase 16: a prefix, not a colour. `colorFor` deliberately returns
    // undefined for both, so a compaction marker is not mistaken for the model
    // speaking — which matters because it is the record of something the user
    // paid for.
    case "compact":
      return "~ ";
    case "notice":
      return "! ";
    default:
      return "";
  }
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
  const [lines, setLines] = useState<Line[]>(initialLines);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
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
        setStatus(
          `${result.stopReason} · ${result.turns} turn(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
            (props.sessionId ? ` · session ${props.sessionId}` : ""),
        );
        props.onTurnEnd?.(result);
      } catch (err) {
        addLines([["error", `loop failed: ${errorText(err)}`]]);
        setStatus("error — type a message and press Enter to retry");
      } finally {
        setBusy(false);
      }
    },
    [messages, busy, addLines, props],
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

  // One input handler for every mode. A second `useInput` would race this one
  // for the same keypress.
  useInput((raw, key) => {
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

    if (key.return) {
      const line = input.trim();
      // `/rewind` is handled here rather than by the model, so it never reaches
      // a provider. Every other line is a prompt, exactly as before.
      if (line === "/rewind") {
        setInput("");
        openPicker();
        return;
      }
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
      return;
    }
    setInput((prev) => prev + raw);
  });

  const panelOpen = picker !== null || confirm !== null;

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
      {panelOpen ? null : (
        <Box marginTop={1}>
          <Text color={busy ? "yellow" : "green"}>{busy ? "…" : "❯"}</Text>
          <Text>
            {busy ? ` ${status}` : ` ${input || status}`}
            {busy ? "" : <Text dimColor>█</Text>}
          </Text>
        </Box>
      )}
      {lines.length === 0 && !busy && !panelOpen ? (
        <Box>
          <Text dimColor>type a message and press Enter · /rewind to restore a turn · Ctrl+C to quit</Text>
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

export type StartChatOptions = Omit<ChatAppProps, "resumeMessages"> & { resumeMessages: ChatMessage[] };

/** Render the interactive chat and resolve when the user quits. */
export async function startChat(options: StartChatOptions): Promise<void> {
  const { render } = await import("ink");
  await render(<ChatApp {...options} />).waitUntilExit();
}
