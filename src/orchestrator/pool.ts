/**
 * The worker pool: bounded-concurrency execution of a task tree.
 *
 * This is the module the Phase 15 gate is stated against — three agents editing
 * three overlapping files with zero conflicts, thread and depth caps that hold
 * under a deliberate fan-out bomb, and a subagent that cannot escalate its own
 * permissions. Each of those is a property of this file, not of the worker that
 * happens to be plugged in, so a caller cannot opt out of any of them by
 * supplying a different `Worker`.
 *
 * ## Concurrency
 *
 * A semaphore over the whole tree, not per level, so a worker that delegates
 * while its siblings still run does not get a fresh budget. `maxThreads` is
 * checked once, at admission, which is what makes the cap hold under a bomb: a
 * worker that returns fifty children has them queued, not run.
 *
 * ## Depth
 *
 * `maxDepth` counts delegation edges. A task the operator started is depth 0, so
 * with the default of 1 a subagent may delegate exactly once. The default is
 * Codex's, and the reason is cost rather than caution: their docs warn that
 * deeper recursion "turns broad delegation instructions into repeated fan-out",
 * which is a description of a bill.
 *
 * ## The permission invariant
 *
 * **A subagent's tool set is an intersection, never a union.** {@link effectiveToolNames}
 * computes `parentTools ∩ declared - disallowed`, and that function is the only
 * path from a declaration to a worker's registry. There is deliberately no
 * branch that adds a tool: the cheapest way to build an escalation is a
 * `declared.length > parent.length` special case, and one that reads as a
 * reasonable merge is the kind of line nobody reviews. A worker also cannot
 * widen anything by *saying* so, because nothing a worker returns is read as
 * configuration — see {@link PoolResult} for what a worker may actually return.
 */

import { join } from "node:path";
import { createWorktree, removeWorktree, safeBranchName, MAX_WORKTREES_PER_RUN } from "./isolation.js";
import { scanSubagentReport } from "./inject.js";
import { clampResult, createTask, saveTask, type IsolationKind, type Task } from "./task.js";
import type { Usage } from "../providers/types.js";

export interface PoolLimits {
  /** Workers running at once. */
  maxThreads: number;
  /** Delegation edges below the operator's task. 0 forbids delegation. */
  maxDepth: number;
  /** Total tasks one run may create, at any depth. */
  maxTasks: number;
}

export const DEFAULT_POOL_LIMITS: PoolLimits = { maxThreads: 6, maxDepth: 1, maxTasks: 32 };

/**
 * The absolute ceiling, applied after the operator's own numbers.
 *
 * A `maxThreads` of 10_000 or a `maxDepth` of 50 is not a preference, it is an
 * unbounded bill and a fork bomb, and it can arrive from a config file the
 * operator edited a year ago or from a fan-out whose row count grew. The clamp
 * is here so that neither needs a second argument.
 */
export const HARD_CEILING: PoolLimits = { maxThreads: 32, maxDepth: 4, maxTasks: 256 };

/**
 * Clamp requested limits into a valid, bounded range.
 *
 * A non-finite, fractional, negative or zero value falls back to the default
 * rather than throwing: limits come from config and CLI flags, and a typo there
 * should not take down a run that is otherwise fine. `maxTasks` is floored at
 * `maxThreads` so a pool can never be configured to admit fewer tasks than it has
 * slots, which would leave threads idle with work queued.
 */
export function clampLimits(requested: Partial<PoolLimits> = {}): PoolLimits {
  return {
    maxThreads: clampNumber(requested.maxThreads, DEFAULT_POOL_LIMITS.maxThreads, 1, HARD_CEILING.maxThreads),
    maxDepth: clampNumber(requested.maxDepth, DEFAULT_POOL_LIMITS.maxDepth, 0, HARD_CEILING.maxDepth),
    maxTasks: Math.max(
      clampNumber(requested.maxTasks, DEFAULT_POOL_LIMITS.maxTasks, 1, HARD_CEILING.maxTasks),
      1,
    ),
  };
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const whole = Math.floor(value);
  if (whole < min) return fallback;
  return Math.min(whole, max);
}

/** What a worker is told about the task it is running. */
export interface WorkerContext {
  /**
   * Mutable, and persisted when the task settles. A worker that wants its task
   * labelled on the board — so `jaa tasks list` shows something a human can read
   * rather than an empty prompt — sets `task.prompt` here. It cannot usefully set
   * anything else: `status`, `depth` and the child list are written by the pool.
   */
  task: Task;
  /** Where the worker runs. The worktree path when isolated, else the repo root. */
  cwd: string;
  depth: number;
  /** The effective limits, so a delegating worker can see the ceiling. */
  limits: PoolLimits;
  /** Aborted when the run is cancelled; a worker should stop at its next check. */
  signal?: AbortSignal;
  /**
   * The tools this worker may use, already narrowed by
   * {@link effectiveToolNames}. Passed rather than read from anywhere else so
   * the narrowing is visible at the point of use.
   */
  tools: string[];
}

/**
 * What a worker may return.
 *
 * Only `output`, `usage` and `children` — the last as a *count and a factory*,
 * never as configuration. A worker that returns a mutated `PoolOptions`, a
 * widened tool list, or a `limits` override has returned a value no part of this
 * file reads, which is the property that makes "a subagent cannot escalate its
 * own permissions" true of the whole tree rather than of one well-behaved
 * worker.
 */
export interface WorkerOutput {
  output: string;
  usage?: Usage;
  /** More work this worker decided to delegate. Subject to the depth cap. */
  children?: Worker[];
}

/** Runs one task. */
export type Worker = (context: WorkerContext) => Promise<WorkerOutput>;

/**
 * A worker's effective tool set.
 *
 * An intersection with what the parent session can already reach, minus the
 * tools the declaration disallows. `declared` omitted means "everything the
 * parent has", which is the parent's set and not a superset of it.
 *
 * Matching is case-insensitive because the permission engine's tool matching
 * already is, and a declaration that said `Write_File` while the parent said
 * `write_file` would otherwise look like a narrowing and silently disable the
 * tool instead of erroring.
 */
export function effectiveToolNames(
  parentTools: readonly string[],
  declared?: readonly string[],
  disallowed?: readonly string[],
): string[] {
  const declaredSet = declared === undefined ? undefined : new Set(declared.map(normalizeToolName));
  const blocked = new Set((disallowed ?? []).map(normalizeToolName));
  const out: string[] = [];
  // Iterating `parentTools` rather than `declared` is what makes this an
  // intersection: a tool the parent lacks is never visited, so it cannot appear.
  for (const tool of parentTools) {
    const key = normalizeToolName(tool);
    if (blocked.has(key)) continue;
    if (declaredSet !== undefined && !declaredSet.has(key)) continue;
    out.push(tool);
  }
  return out;
}

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export type PoolEvent =
  | { type: "task-started"; task: Task }
  | { type: "task-completed"; task: Task; matches: number }
  | { type: "task-failed"; task: Task; error: string }
  | { type: "task-cancelled"; task: Task }
  | { type: "task-refused"; task: Task; reason: string }
  | { type: "isolation-failed"; task: Task; reason: string };

export interface PoolOptions {
  limits?: Partial<PoolLimits>;
  /** `worktree` gives each worker its own checkout. Default `none`. */
  isolation?: IsolationKind;
  /** The repository worktrees are cut from, and where unisolated workers run. */
  repoRoot?: string;
  /** Where worktrees are created. Default `<repoRoot>/.jaa/worktrees`. */
  worktreeBase?: string;
  /** What the parent session can reach. A worker can only ever narrow this. */
  parentTools?: readonly string[];
  /**
   * Required for `worktree` isolation and for any delegation: a worker needs to
   * be told which tools it has, and the only sound answer comes from the parent.
   */
  onEvent?: (event: PoolEvent) => void;
  signal?: AbortSignal;
  /**
   * Kept the worktrees this run created, instead of removing them on the way
   * out. A fan-out whose point is to produce mergeable branches needs them; a
   * fan-out that only wanted the reports does not.
   */
  keepWorktrees?: boolean;
}

export interface PoolTaskResult {
  task: Task;
  children: PoolTaskResult[];
}

export interface PoolResult {
  roots: PoolTaskResult[];
  /** Every task the run created, in completion order. */
  tasks: Task[];
  usage: Usage;
  limits: PoolLimits;
  /** Tasks refused before running, keyed by the reason. */
  refused: Array<{ task: Task; reason: string }>;
}

/**
 * A counting semaphore.
 *
 * Deliberately not a promise pool: a worker that throws must still release its
 * slot, or one failure permanently shrinks the pool and a run that would have
 * finished deadlocks instead. `finally` around the release is what makes that
 * impossible.
 */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) next();
    else this.available++;
  }
}

/** Internal per-run state. */
class RunState {
  readonly tasks: Task[] = [];
  readonly refused: Array<{ task: Task; reason: string }> = [];
  /** Worktrees to remove when the run ends, unless `keepWorktrees`. */
  readonly worktrees: Array<{ path: string; branch: string; repoRoot: string }> = [];
  worktreeCount = 0;

  constructor(
    readonly limits: PoolLimits,
    readonly semaphore: Semaphore,
    readonly options: PoolOptions,
    readonly repoRoot: string,
  ) {}

  get parentTools(): readonly string[] {
    return this.options.parentTools ?? [];
  }

  emit(event: PoolEvent): void {
    this.options.onEvent?.(event);
  }

  cancelled(): boolean {
    return this.options.signal?.aborted === true;
  }
}

/**
 * Run a set of workers concurrently under bounded concurrency and depth.
 *
 * A worker that throws is recorded as a `failed` task and the run continues:
 * one subagent failing is a normal outcome of a fan-out, and the parent needs
 * the other results more than it needs the whole run to be atomic.
 */
export async function runPool(workers: readonly Worker[], options: PoolOptions = {}): Promise<PoolResult> {
  const limits = clampLimits(options.limits);
  const repoRoot = options.repoRoot ?? process.cwd();
  const state = new RunState(limits, new Semaphore(limits.maxThreads), options, repoRoot);
  const parentTools = [...state.parentTools];

  const roots: PoolTaskResult[] = [];
  // Concurrent, not sequential: the semaphore is what bounds the fan-out, and
  // awaiting the roots one at a time here would serialise the entire run and
  // make `maxThreads` meaningless.
  const started = await Promise.all(
    workers.map((worker) => runOne(worker, { depth: 0, parent: undefined, declared: undefined }, state, parentTools)),
  );
  for (const result of started) {
    if (result !== undefined) roots.push(result);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  for (const task of state.tasks) {
    inputTokens += task.usage?.inputTokens ?? 0;
    outputTokens += task.usage?.outputTokens ?? 0;
  }

  if (options.keepWorktrees !== true) {
    // Reverse order, so a worktree is never removed while a later one still
    // references it, and a failure here never masks the run's own outcome.
    for (const worktree of state.worktrees.reverse()) {
      await removeWorktree(worktree).catch(() => false);
    }
  }

  return { roots, tasks: state.tasks, usage: { inputTokens, outputTokens }, limits, refused: state.refused };
}

interface RunFrame {
  depth: number;
  parent: Task | undefined;
  declared: readonly string[] | undefined;
}

async function runOne(
  worker: Worker,
  frame: RunFrame,
  state: RunState,
  parentTools: readonly string[],
): Promise<PoolTaskResult | undefined> {
  if (state.cancelled()) return undefined;

  if (state.tasks.length >= state.limits.maxTasks) {
    const refused = createTask({
      prompt: "(refused: task ceiling reached)",
      ...(frame.parent !== undefined ? { parent: frame.parent.id } : {}),
      depth: frame.depth,
    });
    const reason = `refused: this run already created ${state.tasks.length} of ${state.limits.maxTasks} permitted tasks`;
    state.refused.push({ task: refused, reason });
    state.emit({ type: "task-refused", task: refused, reason });
    return undefined;
  }

  // The declaration is narrowed *before* the task is created, so the task
  // records the tool set the worker will actually have rather than the one it
  // asked for.
  const tools = effectiveToolNames(parentTools, frame.declared);

  const task = createTask({
    prompt: "",
    ...(frame.parent !== undefined ? { parent: frame.parent.id } : {}),
    depth: frame.depth,
  });
  task.status = "running";
  task.startedAt = new Date().toISOString();
  task.updatedAt = task.startedAt;
  state.tasks.push(task);
  if (frame.parent !== undefined) {
    // The parent's child list is appended here, in the run, rather than being
    // trusted from the worker. A worker that miscounts cannot orphan a task.
    frame.parent.children.push(task.id);
    saveTask(frame.parent);
  }
  saveTask(task);
  state.emit({ type: "task-started", task });

  const cwd = await prepareWorkspace(task, state);
  if (cwd === undefined) {
    task.status = "failed";
    task.error = "isolation failed";
    task.finishedAt = new Date().toISOString();
    task.updatedAt = task.finishedAt;
    saveTask(task);
    return { task, children: [] };
  }

  const context: WorkerContext = {
    task,
    cwd,
    depth: frame.depth,
    limits: state.limits,
    tools,
    ...(state.options.signal !== undefined ? { signal: state.options.signal } : {}),
  };

  let output: WorkerOutput;
  // The slot is held for the worker's execution only, and released before any
  // delegation. Holding it across the children would deadlock: every parent
  // would sit on a permit waiting for a child that cannot get one.
  await state.semaphore.acquire();
  try {
    output = await worker(context);
  } catch (err) {
    task.status = state.cancelled() ? "cancelled" : "failed";
    task.error = err instanceof Error ? err.message : String(err);
    task.finishedAt = new Date().toISOString();
    task.updatedAt = task.finishedAt;
    saveTask(task);
    state.emit(
      task.status === "cancelled"
        ? { type: "task-cancelled", task }
        : { type: "task-failed", task, error: task.error },
    );
    return { task, children: [] };
  } finally {
    state.semaphore.release();
  }

  // The scan runs before the result is stored, so an untrusted report is never
  // on the board in a form the parent could pick up unread.
  const scanned = scanSubagentReport(clampResult(output.output ?? ""));
  task.result = scanned.text;
  if (output.usage !== undefined) task.usage = output.usage;
  task.status = "completed";
  task.finishedAt = new Date().toISOString();
  task.updatedAt = task.finishedAt;
  saveTask(task);
  state.emit({ type: "task-completed", task, matches: scanned.matches });

  const children: PoolTaskResult[] = [];
  const delegatable = output.children ?? [];
  if (delegatable.length > 0) {
    if (frame.depth >= state.limits.maxDepth) {
      // Recorded on the task rather than silently dropped: a worker whose
      // delegation was refused should be able to see that it was.
      const note = `delegation refused: depth ${frame.depth} is the configured maximum (maxDepth ${state.limits.maxDepth}); ${delegatable.length} child task(s) not started`;
      task.result = `${task.result}\n\n[orchestrator] ${note}`;
      saveTask(task);
    } else {
      // Children run through the same semaphore, so they queue behind the
      // siblings rather than opening new threads, and they are started
      // concurrently so a parent with many children does not serialise them.
      // Each child inherits the parent's *narrowed* set, so delegation can only
      // ever keep narrowing down the tree.
      const childFrame = (): RunFrame => ({ depth: frame.depth + 1, parent: task, declared: undefined });
      const started = await Promise.all(delegatable.map((child) => runOne(child, childFrame(), state, tools)));
      for (const childResult of started) {
        if (childResult !== undefined) children.push(childResult);
      }
    }
  }

  return { task, children };
}

/**
 * Give the worker a directory, cutting a worktree when isolation asked for one.
 *
 * Returns `undefined` after recording the failure, which is what makes the
 * "isolation is a refusal, not a fallback" rule in `isolation.ts` hold: a worker
 * is never started against a tree it did not get.
 */
async function prepareWorkspace(task: Task, state: RunState): Promise<string | undefined> {
  if (state.options.isolation !== "worktree") return state.repoRoot;

  if (state.worktreeCount >= MAX_WORKTREES_PER_RUN) {
    state.emit({
      type: "isolation-failed",
      task,
      reason: `refused: this run already created ${state.worktreeCount} worktrees, the ceiling for one run`,
    });
    return undefined;
  }

  const base = state.options.worktreeBase ?? join(state.repoRoot, ".jaa", "worktrees");
  const branch = safeBranchName(task.id);
  const created = await createWorktree({
    repoRoot: state.repoRoot,
    path: join(base, task.id),
    branch,
  });

  if (!created.ok) {
    state.emit({ type: "isolation-failed", task, reason: created.message });
    task.isolation = "none";
    task.error = created.message;
    return undefined;
  }

  state.worktreeCount++;
  state.worktrees.push(created.worktree);
  task.isolation = "worktree";
  task.workdir = created.worktree.path;
  return created.worktree.path;
}
