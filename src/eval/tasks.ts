import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "../providers/types.js";
import type { EvalTask, EvalRun } from "./types.js";

export function contains(text: string | RegExp): (result: EvalRun) => boolean {
  return (result) => {
    const last = result.messages?.length ? result.messages[result.messages.length - 1]?.content ?? "" : "";
    return text instanceof RegExp ? text.test(last) : last.includes(text);
  };
}

export function notContains(text: string): (result: EvalRun) => boolean {
  return (result) => {
    const last = result.messages?.length ? result.messages[result.messages.length - 1]?.content ?? "" : "";
    return !last.includes(text);
  };
}

export function toolCalled(name: string): (result: EvalRun) => boolean {
  return (result) => {
    return result.messages?.some((m) => m.toolCalls?.some((c) => c.name === name)) ?? false;
  };
}

export function fileExists(path: string): (result: EvalRun) => boolean {
  return (result) => {
    if (!result.cwd) return false;
    return existsSync(join(result.cwd, path));
  };
}

export function stopReasonIs(reason: "completed" | "max_turns" | "error"): (result: EvalRun) => boolean {
  return (result) => result.stopReason === reason;
}

export function passesChecks(...checks: Array<(result: EvalRun) => boolean>): (result: EvalRun) => boolean {
  return (result) => checks.every((c) => c(result));
}

export function task(
  id: string,
  prompt: string,
  checks: Array<(result: EvalRun) => boolean>,
  opts: Partial<Omit<EvalTask, "id" | "prompt" | "checks">> = {},
): EvalTask {
  return {
    id,
    prompt,
    checks: checks.map((check, i) => ({ name: `check-${i}`, check })),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.setup !== undefined ? { setup: opts.setup } : {}),
  };
}

export function loadTasks(dir: string): EvalTask[] {
  if (!existsSync(dir)) return [];
  const tasks: EvalTask[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const raw = JSON.parse(readFileSync(join(dir, entry.name), "utf8")) as unknown;
    if (Array.isArray(raw)) {
      for (const item of raw) tasks.push(normalizeTask(item));
    } else {
      tasks.push(normalizeTask(raw));
    }
  }
  return tasks;
}

function normalizeTask(item: unknown): EvalTask {
  const obj = item as Record<string, unknown>;
  const task: EvalTask = {
    id: String(obj.id ?? "task"),
    prompt: String(obj.prompt ?? ""),
    checks: Array.isArray(obj.checks) ? (obj.checks as EvalTask["checks"]) : [],
  };
  if (typeof obj.maxTurns === "number") task.maxTurns = obj.maxTurns;
  if (typeof obj.tokenBudget === "number") task.tokenBudget = obj.tokenBudget;
  if (typeof obj.temperature === "number") task.temperature = obj.temperature;
  if (Array.isArray(obj.tools)) task.tools = obj.tools as ToolDef[];
  if (typeof obj.setup === "object" && obj.setup !== null) task.setup = obj.setup as Record<string, string>;
  return task;
}