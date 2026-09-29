/**
 * Wrap a tool executor so a mutating call's diagnostics land on its result.
 *
 * Extracted from the CLI so that both `ask` and `chat` get it, and so it can be
 * tested. The wiring used to live inline in the `ask` action, which made the one
 * property that matters untestable: **does the compiler's verdict reach the saved
 * session, or only the live turn?**
 *
 * It does reach it, and that is the point of the phase. The tool result is part
 * of `result.messages`, the delta persisted by `ask` is a slice of exactly that
 * array, and this wrapper's extra text is written into the result the loop
 * stores. So `jaa session show` replays the compiler's verdict, not the agent's
 * claim about it — the difference between a transcript that records what was
 * found and one that records what was asserted.
 *
 * The wrapper deliberately does not touch the permission gate: `inner` is already
 * gated by the caller, so the call passes the engine exactly once and only the
 * *result* gains text.
 */
export function withDiagnostics(
  inner: (call: ToolCall) => Promise<string>,
  options: LspLoopOptions & { mutatingTools?: readonly string[] },
  onReport?: (report: DiagnosticsReport & { path: string }) => void,
): (call: ToolCall) => Promise<string> {
  // The permission engine's own list, read rather than copied: a snapshot and a
  // diagnostics refresh should agree about which calls can change a file.
  const mutating = options.mutatingTools ?? MUTATING_TOOLS;

  return async (call) => {
    const result = await inner(call);
    if (!mutating.includes(call.name)) return result;
    const path = writtenPath(call);
    if (path === undefined) return result;
    const report = await refreshDiagnostics(options, path);
    onReport?.({ ...report, path });
    // Empty text is the common case — a clean file after an edit — and appending
    // "no problems" to every successful write would spend tokens restating what
    // the absence of an error already says.
    return report.text === "" ? result : `${result}${report.text}`;
  };
}

/**
 * Loop integration: surface a tool call's real diagnostics without the model
 * asking for them.
 *
 * ## The gate this exists to pass
 *
 * "Editing a file with a type error surfaces that error to the agent on the next
 * turn without the model being asked."
 *
 * That is the whole point of the phase. An agent that hallucinates a type error
 * is worse than useless — it will "fix" code that was correct, and the mistake
 * is invisible because the model asserted it confidently. Competitors feed real
 * compiler output back into the loop; this is the same thing.
 *
 * ## Why it rides on the tool result and not on a message
 *
 * A provider requires every tool result to immediately follow the assistant
 * message that proposed the call, and a standalone system message in that gap is
 * a malformed request — the constraint `appendHookContext` already documents for
 * hooks. The same rule applies here, and for a second reason: inserting a
 * message moves every later message one position along, which is exactly the
 * drift the Phase 14 turn index exists to avoid. So the diagnostics are appended
 * to the result, which keeps the transcript, `turnIndex` and the saved session
 * all consistent.
 *
 * ## It is best-effort by construction
 *
 * This runs after every mutating tool call, on the hot path. A language server
 * that is slow, wedged, missing or broken must not be able to fail a write that
 * already succeeded — so every failure path returns without throwing, and a
 * timeout is bounded.
 */

import type { LspManager } from "../lsp/manager.js";
import { MUTATING_TOOLS } from "../permissions/rules.js";
import type { ToolCall } from "../providers/types.js";

/** How long a post-edit diagnostics refresh may take before it is abandoned. */
export const DEFAULT_DIAGNOSTIC_REFRESH_MS = 8_000;

const MUTATING_ARG_KEYS = ["path", "file", "filePath", "file_path", "target"] as const;

export interface LspLoopOptions {
  manager: LspManager;
  /** Workspace root the tools are confined to. */
  root: string;
  /** Skip the refresh, e.g. while the user is mid-typing in a TUI. */
  enabled?: boolean;
  /** Bound on one refresh. */
  timeoutMs?: number;
}

/** The path a mutating call wrote, if it names one. */
export function writtenPath(call: ToolCall): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return undefined;
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of MUTATING_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

export interface DiagnosticsReport {
  /** The text to append to the tool result. Empty when there is nothing to add. */
  text: string;
  /** How many problems the server reported. */
  count: number;
  /** Why nothing was added, when `text` is empty. */
  reason?: string;
}

/**
 * Render a file's diagnostics for appending to a tool result.
 *
 * Returns empty text — not an error — when there is nothing to say. A clean file
 * after an edit is the *expected* outcome, and appending "no problems" to every
 * successful write would spend tokens restating what the absence of an error
 * already says.
 */
export async function refreshDiagnostics(
  options: LspLoopOptions,
  relativePath: string,
): Promise<DiagnosticsReport> {
  if (options.enabled === false) return { text: "", count: 0, reason: "disabled" };

  const language = options.manager.languageFor(relativePath);
  if (language === undefined) return { text: "", count: 0, reason: "no language server for this file type" };
  if (!options.manager.hasServerFor(relativePath)) {
    return { text: "", count: 0, reason: `the ${language} language server is not available here` };
  }

  const budget = options.timeoutMs ?? DEFAULT_DIAGNOSTIC_REFRESH_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Bounded: the server indexes a project on first contact, and that is not
    // allowed to become the time it takes to answer "the write succeeded".
    const outcome = await Promise.race([
      options.manager.diagnostics(relativePath, undefined, { timeoutMs: budget }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budget + 500);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);

    if (outcome === undefined) return { text: "", count: 0, reason: "the language server did not answer in time" };
    if (outcome.status !== "ok") return { text: "", count: 0, reason: outcome.reason };

    const items = outcome.result.items;
    if (items.length === 0) return { text: "", count: 0 };

    const lines = [`[lsp] ${relativePath}: ${items.length} problem(s) the ${outcome.language} language server reports`];
    for (const item of items.slice(0, 20)) {
      const at = item.range?.start;
      const where = at === undefined ? "" : `:${at.line + 1}:${at.character + 1}`;
      const severity = item.severity === 2 ? "warning" : (item.severity ?? 1) >= 3 ? "notice" : "error";
      lines.push(`  [${severity}]${where} ${item.message.replace(/\s+/g, " ")}`);
    }
    if (items.length > 20) lines.push(`  … ${items.length - 20} more`);
    return { text: `\n\n${lines.join("\n")}`, count: items.length };
  } catch (err) {
    // The write already happened and succeeded. Nothing here may undo that, and
    // nothing here may throw.
    return { text: "", count: 0, reason: `diagnostics failed: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
