import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, EvalRun } from "./types.js";
import { runAgentLoop } from "../agent/loop.js";
import type { ResolvedModel } from "../providers/types.js";
import type { ToolExecutor } from "../agent/loop.js";

export interface EvalOptions {
  model: ResolvedModel;
  executeTool: ToolExecutor;
  cwd?: string;
  retries?: number;
}

export async function runEvalTask(task: EvalTask, options: EvalOptions): Promise<EvalRun> {
  const start = Date.now();
  const retries = Math.max(0, options.retries ?? 0);
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), "jaa-eval-"));
  let setupCleanup: (() => void) | undefined;
  if (task.setup) {
    setupCleanup = () => rmSync(cwd, { recursive: true, force: true });
    for (const [path, content] of Object.entries(task.setup)) {
      writeFileSync(join(cwd, path), content, "utf8");
    }
  }

  let lastError: string | undefined;
  let attempts = 0;
  let run: EvalRun | undefined;
  try {
    do {
      attempts++;
      run = await runOnce(task, options, cwd);
      if (run.pass) break;
      lastError = run.error;
    } while (attempts <= retries);
  } finally {
    setupCleanup?.();
  }

  if (!run) {
    run = {
      taskId: task.id,
      prompt: task.prompt,
      pass: false,
      checks: [],
      stopReason: "error",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - start,
      retries,
      error: lastError ?? "eval run failed",
    };
  }

  return {
    ...run,
    retries: attempts - 1,
    durationMs: Date.now() - start,
  };
}

async function runOnce(task: EvalTask, options: EvalOptions, cwd: string): Promise<EvalRun> {
  const messages = [
    { role: "system" as const, content: "You are a helpful assistant. Be concise and precise." },
    { role: "user" as const, content: task.prompt },
  ];

  const executeTool = options.executeTool;
  const loopOptions: Parameters<typeof runAgentLoop>[0] = {
    model: options.model,
    messages,
    executeTool,
  };
  if (task.tools !== undefined) loopOptions.tools = task.tools;
  if (task.maxTurns !== undefined) loopOptions.maxTurns = task.maxTurns;
  if (task.tokenBudget !== undefined) loopOptions.tokenBudget = task.tokenBudget;
  if (task.temperature !== undefined) loopOptions.temperature = task.temperature;
  const result = await runAgentLoop(loopOptions);

  const base: EvalRun = {
    taskId: task.id,
    prompt: task.prompt,
    pass: false,
    checks: [],
    stopReason: result.stopReason,
    turns: result.turns,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: 0,
    retries: 0,
    cwd,
    messages: result.messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
    })),
  };

  const checks = task.checks.map((check) => ({
    name: check.name,
    pass: check.check(base),
  }));

  return {
    ...base,
    checks,
    pass: checks.every((c) => c.pass),
  };
}

export function evaluateChecks(task: EvalTask, result: EvalRun): EvalRun {
  const checks = task.checks.map((check) => ({
    name: check.name,
    pass: check.check(result),
  }));
  return {
    ...result,
    checks,
    pass: checks.every((c) => c.pass),
  };
}

export function summarize(runs: EvalRun[]): {
  passAt1: number;
  passAtN: number;
  total: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
} {
  const total = runs.length;
  const passAt1 = runs.filter((r) => r.pass && r.retries === 0).length;
  const passAtN = runs.filter((r) => r.pass).length;
  const totalDurationMs = runs.reduce((s, r) => s + r.durationMs, 0);
  const totalInputTokens = runs.reduce((s, r) => s + r.inputTokens, 0);
  const totalOutputTokens = runs.reduce((s, r) => s + r.outputTokens, 0);
  return { passAt1, passAtN, total, totalDurationMs, totalInputTokens, totalOutputTokens };
}