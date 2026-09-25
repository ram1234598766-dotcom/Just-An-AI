import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { runBenchCase } from "./runner.js";
import { BENCH_TAGS } from "./types.js";
import type { BenchCase, BenchResult, BenchTag, HarnessAdapter } from "./types.js";

export interface MatrixOptions {
  model: string;
  timeoutMs?: number;
  /** NDJSON file of prior results. Matching caseId+harness+model pairs are skipped. */
  resumeFrom?: string;
  /** Called after every result so callers can stream progress. */
  onResult?: (result: BenchResult) => void;
}

export function resultKey(r: Pick<BenchResult, "caseId" | "harness" | "model">): string {
  return `${r.caseId}::${r.harness}::${r.model}`;
}

export function appendResult(path: string, result: BenchResult): void {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(result)}\n`, "utf8");
}

export function loadMatrixResults(path: string): BenchResult[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: BenchResult[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // The resume file is untrusted input: it may be hand-edited, truncated,
      // or crafted. Validate rather than assert.
      const parsed = normalizeRecord(JSON.parse(trimmed) as unknown);
      if (parsed) out.push(parsed);
    } catch {
      // A truncated final line from an interrupted run is expected; skip it.
    }
  }
  return out;
}

const KNOWN_TAGS = new Set<string>(BENCH_TAGS);

function normalizeRecord(value: unknown): BenchResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.caseId !== "string" || typeof o.harness !== "string") return undefined;

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const strArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const tags = Array.isArray(o.tags) ? o.tags.filter((t): t is BenchTag => typeof t === "string" && KNOWN_TAGS.has(t)) : undefined;
  const toolCalls = Array.isArray(o.toolCalls)
    ? o.toolCalls
        .map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>).name : undefined))
        .filter((n): n is string => typeof n === "string")
        .map((name) => ({ name }))
    : [];

  return {
    caseId: o.caseId,
    harness: o.harness,
    model: typeof o.model === "string" ? o.model : "",
    pass: o.pass === true,
    checks: Array.isArray(o.checks)
      ? o.checks
          .map((c) => (typeof c === "object" && c !== null ? (c as Record<string, unknown>) : {}))
          .map((c) => ({ name: String(c.name ?? "check"), pass: c.pass === true }))
      : [],
    turns: num(o.turns),
    wallMs: num(o.wallMs),
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
    costUsd: num(o.costUsd),
    toolCalls,
    diffFiles: strArray(o.diffFiles),
    ...(tags !== undefined ? { tags } : {}),
    ...(typeof o.finalText === "string" ? { finalText: o.finalText } : {}),
    ...(typeof o.error === "string" ? { error: o.error } : {}),
    ...(o.skipped === true ? { skipped: true } : {}),
    ...(typeof o.skipReason === "string" ? { skipReason: o.skipReason } : {}),
  };
}

export async function runMatrix(
  cases: BenchCase[],
  adapters: HarnessAdapter[],
  options: MatrixOptions,
): Promise<BenchResult[]> {
  const prior = options.resumeFrom ? loadMatrixResults(options.resumeFrom) : [];
  const done = new Set(prior.map(resultKey));
  const results: BenchResult[] = [...prior];

  for (const adapter of adapters) {
    for (const caseDef of cases) {
      const key = resultKey({ caseId: caseDef.id, harness: adapter.id, model: options.model });
      if (done.has(key)) continue;

      // One bad case must never end the matrix: a resumable harness exists
      // precisely because failures are expected.
      let result: BenchResult;
      try {
        const runOptions: Parameters<typeof runBenchCase>[2] = { model: options.model };
        if (options.timeoutMs !== undefined) runOptions.timeoutMs = options.timeoutMs;
        result = await runBenchCase(caseDef, adapter, runOptions);
      } catch (err) {
        result = {
          caseId: caseDef.id,
          harness: adapter.id,
          model: options.model,
          pass: false,
          checks: [],
          turns: 0,
          wallMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          toolCalls: [],
          diffFiles: [],
          tags: caseDef.tags,
          error: `harness threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      results.push(result);
      done.add(key);
      if (options.resumeFrom) appendResult(options.resumeFrom, result);
      options.onResult?.(result);
    }
  }

  return results;
}
