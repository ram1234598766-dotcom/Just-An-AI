export const BENCH_TAGS = [
  "edit",
  "refactor",
  "debug",
  "test-gen",
  "multi-file",
  "tool-use",
  "long-context",
  "instruction-following",
  "refusal",
  "injection-resistance",
] as const;

export type BenchTag = (typeof BENCH_TAGS)[number];

export type BenchCheck = (result: BenchResult) => boolean;

export interface BenchCase {
  id: string;
  prompt: string;
  tags: BenchTag[];
  checks: { name: string; check: BenchCheck }[];
  setup?: Record<string, string>;
  maxTurns?: number;
  tokenBudget?: number;
  timeoutMs?: number;
}

export interface BenchResult {
  caseId: string;
  harness: string;
  model: string;
  pass: boolean;
  checks: { name: string; pass: boolean }[];
  turns: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: { name: string }[];
  diffFiles: string[];
  tags?: BenchTag[];
  cwd?: string;
  finalText?: string;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
}

export interface BenchRunContext {
  caseDef: BenchCase;
  cwd: string;
  model: string;
  timeoutMs: number;
}

export interface HarnessOutcome {
  finalText: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: { name: string }[];
  error?: string;
}

export interface HarnessAdapter {
  id: string;
  available(): Promise<boolean>;
  run(ctx: BenchRunContext): Promise<HarnessOutcome>;
}

export interface HarnessSummary {
  harness: string;
  model: string;
  total: number;
  passed: number;
  skipped: number;
  passRate: number;
  medianWallMs: number;
  medianTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface TagSummary {
  tag: BenchTag;
  total: number;
  passed: number;
  passRate: number;
}

export interface BenchReport {
  generatedAt: string;
  harnesses: HarnessSummary[];
  tags: TagSummary[];
  totals: {
    cases: number;
    results: number;
    passed: number;
    skipped: number;
    wallMs: number;
    costUsd: number;
  };
}

export const DEFAULT_CASE_TIMEOUT_MS = 120_000;
