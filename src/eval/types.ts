import type { ToolDef } from "../providers/types.js";

export interface EvalCheck {
  name: string;
  check: (result: EvalRun) => boolean;
}

export interface EvalTask {
  id: string;
  prompt: string;
  checks: EvalCheck[];
  maxTurns?: number;
  tokenBudget?: number;
  temperature?: number;
  tools?: ToolDef[];
  setup?: Record<string, string>;
}

export interface EvalRun {
  taskId: string;
  prompt: string;
  pass: boolean;
  checks: { name: string; pass: boolean }[];
  stopReason: "completed" | "max_turns" | "error";
  turns: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  retries: number;
  cwd?: string;
  messages?: { role: string; content: string; toolCalls?: { name: string; arguments: string }[] }[];
  error?: string;
}

export interface EvalSuiteResult {
  runs: EvalRun[];
  passAt1: number;
  passAtN: number;
  total: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}