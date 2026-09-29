/**
 * Detached workers that outlive the turn that started them.
 *
 * A parent that waits for every child is not an orchestrator, it is a queue: a
 * nine-minute worker blocks a turn that had other work to do, and if the parent
 * exits, the work stops. Background execution fixes both by moving the worker
 * into its own process and leaving a record on the board.
 *
 * ## How detachment actually works here
 *
 * A real `fork()` is not available on Windows without a native addon, and a
 * native addon would make `jaa` un-installable without a build toolchain — the
 * same reason Phase 12 declined Job Objects. So detachment is a detached child
 * process instead: `spawn` with `detached: true` and `stdio: "ignore"`, which
 * gives a worker that survives the parent's exit and keeps none of the parent's
 * file descriptors, including its terminal. That is a genuine detach, not a
 * simulated one, and it is testable because the child writes to the same board
 * the parent reads.
 *
 * The cost of a separate process is that "cancel" cannot be a signal — the
 * parent does not hold a handle to the child's work. Instead cancellation is
 * cooperative and *observable*: {@link requestStop} marks the task `cancelled`
 * on the board and the child notices on its next poll. A child that is inside a
 * long provider call will finish that call first, so stop is not immediate and
 * {@link isStopped} exists so a caller can report the difference rather than
 * promise a kill it did not perform.
 *
 * ## The board is the only channel
 *
 * The child writes its result to its own task file; the parent reads it with
 * {@link collectResults}. There is no pipe, which is what lets the parent
 * detach and re-attach in a different process entirely, hours later.
 */

import { spawn } from "node:child_process";
import { listTasks, loadTask, saveTask, type Task } from "./task.js";
import type { Usage } from "../providers/types.js";

/** How often a child checks the board for a stop request. */
export const STOP_POLL_MS = 1_000;

/** How long a detached worker may run before the parent reports it as stale. */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1_000;

export interface DetachRequest {
  /** The argv to run, without the interpreter. */
  argv: readonly string[];
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Injected for tests; defaults to `process.execPath`. */
  interpreter?: string;
  /** Injected for tests; defaults to `spawn`. */
  spawnImpl?: typeof spawn;
}

export interface DetachHandle {
  pid: number | undefined;
  argv: string[];
  cwd: string;
  /** Always true on success; present so a caller never assumes a kill switch. */
  detached: true;
}

export class DetachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DetachError";
  }
}

/**
 * Start a worker in its own process and return immediately.
 *
 * The child is unref'd, so it does not keep this process alive, and its stdio
 * is ignored rather than inherited — an inherited terminal would have two
 * processes writing to one console, which corrupts the parent's TUI.
 */
export function detachProcess(request: DetachRequest): DetachHandle {
  const interpreter = request.interpreter ?? process.execPath;
  const argv = [interpreter, ...request.argv];
  const cwd = request.cwd ?? process.cwd();
  const spawnImpl = request.spawnImpl ?? spawn;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawnImpl(interpreter, [...request.argv], {
      cwd,
      detached: true,
      stdio: "ignore",
      // Without this the parent's exit waits on the child, which is the exact
      // opposite of detaching.
      windowsHide: true,
    });
  } catch (err) {
    throw new DetachError(`could not start a detached worker: ${err instanceof Error ? err.message : String(err)}`);
  }

  // An `error` event is asynchronous, so a missing git or a bad path surfaces
  // here rather than at the throw above. Handled rather than left to crash the
  // parent with an unhandled 'error' event.
  child.on?.("error", () => {
    // The task stays `pending`; `collectResults` reports it as unfinished, which
    // is the truth. Nothing here can be reported to a caller that has already
    // been given a handle.
  });

  child.unref?.();
  return { pid: child.pid, argv, cwd, detached: true };
}

/**
 * Ask a background task to stop.
 *
 * Cooperative: it marks the board and the child notices on its next poll. The
 * function is honest about that — it does not return "stopped", it returns
 * whether the request was recorded.
 */
export function requestStop(taskId: string, reason = "stopped by the operator"): boolean {
  let task: Task | undefined;
  try {
    task = loadTask(taskId);
  } catch {
    return false;
  }
  if (task === undefined) return false;
  if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return false;
  task.status = "cancelled";
  task.error = reason;
  task.finishedAt = new Date().toISOString();
  task.updatedAt = task.finishedAt;
  try {
    saveTask(task);
  } catch {
    return false;
  }
  return true;
}

/** Has this task been asked to stop? A worker polls this between steps. */
export function isStopped(taskId: string): boolean {
  try {
    return loadTask(taskId)?.status === "cancelled";
  } catch {
    // A board that cannot be read is not a reason to keep spending money.
    return true;
  }
}

export interface CollectedResult {
  taskId: string;
  status: Task["status"];
  /** The scanned result, once the task has finished. */
  result?: string;
  error?: string;
  usage?: Usage;
  /** A running task with no heartbeat inside the stale window. */
  stale: boolean;
}

/** A running task with no heartbeat inside the stale window. */
export function isStale(task: Task, now: number, staleAfterMs: number): boolean {
  if (task.status !== "running" && task.status !== "pending") return false;
  const stamp = Date.parse(task.updatedAt);
  if (Number.isNaN(stamp)) return true;
  return now - stamp > staleAfterMs;
}

/**
 * Read the results of background tasks back into the parent.
 *
 * This is what makes `jaa tasks attach` work in a process that never spawned
 * anything: it reads the board by id and nothing else. A task that is still
 * running is reported as such, with a `stale` flag, so a caller can say "still
 * going" or "stopped making progress" instead of presenting silence as a result.
 */
export function collectResults(
  taskIds: readonly string[],
  options: { now?: number; staleAfterMs?: number } = {},
): CollectedResult[] {
  const now = options.now ?? Date.now();
  const staleAfter = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const out: CollectedResult[] = [];

  for (const id of taskIds) {
    let task: Task | undefined;
    try {
      task = loadTask(id);
    } catch (err) {
      out.push({
        taskId: id,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        stale: false,
      });
      continue;
    }
    if (task === undefined) {
      out.push({ taskId: id, status: "failed", error: `task ${id} is not on the board`, stale: false });
      continue;
    }
    const entry: CollectedResult = {
      taskId: id,
      status: task.status,
      stale: isStale(task, now, staleAfter),
    };
    if (task.result !== undefined) entry.result = task.result;
    if (task.error !== undefined) entry.error = task.error;
    if (task.usage !== undefined) entry.usage = task.usage;
    out.push(entry);
  }

  return out;
}

export interface Summary {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
  stale: number;
  usage: Usage;
  /** One line per task, for the parent transcript. */
  lines: string[];
}

/**
 * The completion summary a parent puts in its own transcript.
 *
 * Results are included for finished tasks and withheld for running ones, because
 * a summary that mixed a half-finished task's absence of output in with a real
 * result would be indistinguishable from a task that produced nothing.
 */
export function summarize(results: readonly CollectedResult[]): Summary {
  let inputTokens = 0;
  let outputTokens = 0;
  const lines: string[] = [];

  for (const result of results) {
    inputTokens += result.usage?.inputTokens ?? 0;
    outputTokens += result.usage?.outputTokens ?? 0;
    const note = result.stale ? " (no progress in the stale window)" : "";
    lines.push(`  ${result.taskId}: ${result.status}${note}`);
    if (result.status === "completed" && result.result !== undefined) {
      lines.push(indent(result.result));
    }
    if (result.status === "failed" && result.error !== undefined) {
      lines.push(indent(`error: ${result.error}`));
    }
  }

  return {
    total: results.length,
    completed: results.filter((r) => r.status === "completed").length,
    failed: results.filter((r) => r.status === "failed").length,
    cancelled: results.filter((r) => r.status === "cancelled").length,
    running: results.filter((r) => r.status === "running" || r.status === "pending").length,
    stale: results.filter((r) => r.stale).length,
    usage: { inputTokens, outputTokens },
    lines,
  };
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/** Every task that has not finished — what `jaa tasks list --running` shows. */
export function unfinishedTasks(): Task[] {
  return listTasks().filter((task) => task.status === "pending" || task.status === "running");
}
