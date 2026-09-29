/**
 * The task board: one JSON file per task under `~/.jaa/tasks/`.
 *
 * A task is the unit of multi-agent work. It carries the prompt, which agent
 * runs it, its lifecycle status, its result, and the `parent`/`children` links
 * that make the delegation tree reconstructable.
 *
 * ## Why one file per task, and not one board file
 *
 * A run is a tree, and a tree is written from many places at once — the parent
 * sets a child to `running` while a sibling finishes and a grandchild is
 * created. A single board file would make every one of those writers race for
 * the same read-modify-write, and a crash mid-write would destroy the states of
 * every other task along with it. Per-task files make each write independent,
 * so a crash loses at most the one task being written, and the tree is rebuilt
 * by following the `parent` links rather than by holding them in one document.
 *
 * ## The same boundary discipline as every other on-disk store here
 *
 * Ids are validated against a strict pattern *before* they become a filename,
 * and every read validates against a zod schema, because the file may have been
 * hand-edited, truncated, or written by a version with a different shape. A file
 * that does not parse is skipped by the listing rather than surfaced, and it is
 * never deleted on the strength of failing to parse.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jaaPaths } from "../config/paths.js";
import type { Usage } from "../providers/types.js";

const TASK_ID_PATTERN = /^t-[A-Za-z0-9_-]{4,63}$/;
const FILE_PERMS = 0o600;

/** The maximum size of a stored result, so a runaway agent cannot fill the disk. */
export const MAX_RESULT_CHARS = 200_000;

export const TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** How a worker is kept from colliding with its siblings. */
export const ISOLATION_KINDS = ["none", "worktree"] as const;
export type IsolationKind = (typeof ISOLATION_KINDS)[number];

export interface Task {
  id: string;
  /** The prompt handed to the worker. */
  prompt: string;
  /** Name of the AGENTS.md subagent that runs it, if any. */
  agent?: string;
  status: TaskStatus;
  /** The worker's final answer, after the injection scan. */
  result?: string;
  /** Why it failed, when `status` is `failed`. */
  error?: string;
  /** The task that delegated this one. Absent on a root task. */
  parent?: string;
  /** Tasks this one delegated. Maintained by the pool, not by the delegate. */
  children: string[];
  /** 0 for a task the operator started; 1+ for one a subagent created. */
  depth: number;
  /** `worktree` when the worker got its own git worktree. */
  isolation: IsolationKind;
  /** The worktree path, when `isolation` is `worktree`. */
  workdir?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** Cumulative provider usage for this task, when the worker reported it. */
  usage?: Usage;
}

export interface NewTaskOptions {
  prompt: string;
  agent?: string;
  parent?: string;
  depth?: number;
  isolation?: IsolationKind;
  workdir?: string;
}

const taskSchema = z.object({
  id: z.string().regex(TASK_ID_PATTERN),
  prompt: z.string(),
  agent: z.string().optional(),
  status: z.enum(TASK_STATUSES),
  result: z.string().optional(),
  error: z.string().optional(),
  parent: z.string().optional(),
  children: z.array(z.string()),
  depth: z.number().int().min(0),
  isolation: z.enum(ISOLATION_KINDS),
  workdir: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
});

function tasksDir(): string {
  return join(jaaPaths().root, "tasks");
}

function assertSafeId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`invalid task id "${id}"`);
  }
}

function taskFilePath(id: string): string {
  assertSafeId(id);
  return join(tasksDir(), `${id}.json`);
}

/** Monotonic-ish id: base36 timestamp + random hex. Safe as a filename. */
export function newTaskId(): string {
  return `t-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** A fresh `pending` task. Not written to disk until {@link saveTask}. */
export function createTask(options: NewTaskOptions): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: newTaskId(),
    prompt: options.prompt,
    status: "pending",
    children: [],
    depth: options.depth ?? 0,
    isolation: options.isolation ?? "none",
    createdAt: now,
    updatedAt: now,
  };
  if (options.agent !== undefined) task.agent = options.agent;
  if (options.parent !== undefined) task.parent = options.parent;
  if (options.workdir !== undefined) task.workdir = options.workdir;
  return task;
}

/**
 * A task's stored result, truncated to {@link MAX_RESULT_CHARS}.
 *
 * Truncation is applied on the way in rather than on the way out so a result
 * too large to be useful is never written to the disk in the first place. The
 * marker is explicit so a reader can tell a truncated result from a complete
 * one instead of treating the cut as the end of the answer.
 */
export function clampResult(result: string): string {
  if (result.length <= MAX_RESULT_CHARS) return result;
  return `${result.slice(0, MAX_RESULT_CHARS)}\n\n[truncated: result exceeded ${MAX_RESULT_CHARS} characters]`;
}

/**
 * Writes a task atomically (temp file + rename) and locks it to owner-only on
 * POSIX. Same contract as `saveSession`, because it is the same kind of state:
 * agent output, read back later by a different process.
 */
export function saveTask(task: Task): void {
  assertSafeId(task.id);
  const dir = tasksDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${task.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: FILE_PERMS });
  if (process.platform !== "win32") chmodSync(tmp, FILE_PERMS);
  renameSync(tmp, file);
}

/** Loads a task; returns `undefined` for an unknown id. Throws on a corrupt file. */
export function loadTask(id: string): Task | undefined {
  const file = taskFilePath(id);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`task "${id}" is corrupt (not valid JSON)`);
  }
  const result = taskSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`task "${id}" is corrupt (schema mismatch: ${result.error.issues[0]?.path.join(".") ?? "unknown"})`);
  }
  return result.data as Task;
}

/** Every stored task, newest-created first. Corrupt and unknown files are skipped. */
export function listTasks(): Task[] {
  const dir = tasksDir();
  if (!existsSync(dir)) return [];
  const tasks: Task[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!TASK_ID_PATTERN.test(id)) continue;
    let task: Task | undefined;
    try {
      task = loadTask(id);
    } catch {
      continue; // unreadable/corrupt — skip
    }
    if (task) tasks.push(task);
  }
  if (tasks.length > 0) {
    tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }
  return tasks;
}

/** Removes a task file. Returns true when something was deleted. */
export function removeTask(id: string): boolean {
  const file = taskFilePath(id);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

// --- tree helpers ----------------------------------------------------------

/**
 * Every task that descends from `rootId`, breadth-first.
 *
 * Follows `children` rather than `parent`, because a parent may record a child
 * before the child's own file exists — a crash in that window would otherwise
 * hide the child permanently from a parent-side walk. The `seen` set makes a
 * cycle (which a corrupt or hand-edited board can contain) terminate instead of
 * looping forever.
 */
export function descendantsOf(rootId: string, all: Task[] = listTasks()): Task[] {
  const byParent = new Map<string, Task[]>();
  for (const task of all) {
    if (task.parent === undefined) continue;
    const siblings = byParent.get(task.parent);
    if (siblings) siblings.push(task);
    else byParent.set(task.parent, [task]);
  }

  const out: Task[] = [];
  const seen = new Set<string>([rootId]);
  const queue = [...(byParent.get(rootId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined || seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
    queue.push(...(byParent.get(next.id) ?? []));
  }
  return out;
}

/** The chain from `taskId` up to its root, nearest ancestor first. Cycle-safe. */
export function ancestorsOf(taskId: string, all: Task[] = listTasks()): Task[] {
  const byId = new Map(all.map((task) => [task.id, task]));
  const chain: Task[] = [];
  const seen = new Set<string>([taskId]);
  let current = byId.get(taskId)?.parent;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const task = byId.get(current);
    if (task === undefined) break;
    chain.push(task);
    current = task.parent;
  }
  return chain;
}

/**
 * Total token spend across a task and all its descendants.
 *
 * Walked rather than summed over the flat list so two workers cannot double
 * count a shared grandchild, and so a root task's cost includes the whole tree
 * it caused.
 */
export function treeUsage(rootId: string, all: Task[] = listTasks()): Usage {
  const root = all.find((task) => task.id === rootId);
  const members = root === undefined ? [] : [root, ...descendantsOf(rootId, all)];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const task of members) {
    inputTokens += task.usage?.inputTokens ?? 0;
    outputTokens += task.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

export { TASK_ID_PATTERN, tasksDir, taskFilePath };
