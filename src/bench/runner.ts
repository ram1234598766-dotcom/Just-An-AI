import { createHash } from "node:crypto";
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { DEFAULT_CASE_TIMEOUT_MS } from "./types.js";
import type { BenchCase, BenchResult, BenchRunContext, HarnessAdapter, HarnessOutcome } from "./types.js";

export interface RunCaseOptions {
  model: string;
  timeoutMs?: number;
  /** Keep the case directory after the run. Off by default so temp dirs do not leak. */
  keepWorkdir?: boolean;
}

export async function runBenchCase(
  caseDef: BenchCase,
  adapter: HarnessAdapter,
  options: RunCaseOptions,
): Promise<BenchResult> {
  const start = Date.now();
  const model = options.model;
  const timeoutMs = caseDef.timeoutMs ?? options.timeoutMs ?? DEFAULT_CASE_TIMEOUT_MS;

  if (!(await withHardTimeout(adapter.available(), timeoutMs, `${adapter.id} availability probe`))) {
    return {
      caseId: caseDef.id,
      harness: adapter.id,
      model,
      pass: false,
      checks: [],
      turns: 0,
      wallMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [],
      diffFiles: [],
      tags: caseDef.tags,
      skipped: true,
      skipReason: `harness "${adapter.id}" unavailable on this host`,
    };
  }

  const cwd = mkdtempSync(join(tmpdir(), "jaa-bench-"));
  const keep = options.keepWorkdir === true;
  try {
    applySetup(cwd, caseDef.setup);
    const before = snapshot(cwd);

    const outcome = await attempt(adapter, { caseDef, cwd, model, timeoutMs }, adapter.id);

    const diffFiles = diff(cwd, before);
    const base: BenchResult = {
      caseId: caseDef.id,
      harness: adapter.id,
      model,
      pass: false,
      checks: [],
      turns: outcome.turns,
      wallMs: Date.now() - start,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: outcome.costUsd,
      toolCalls: outcome.toolCalls,
      diffFiles,
      tags: caseDef.tags,
      cwd,
      finalText: outcome.finalText,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };

    const checks = caseDef.checks.map((c) => ({ name: c.name, pass: c.check(base) }));
    const result: BenchResult = { ...base, checks, pass: checks.every((c) => c.pass) };
    // The work dir is removed below unless explicitly retained, so do not hand
    // back a path that will no longer resolve.
    if (!keep) delete result.cwd;
    return result;
  } catch (err) {
    // A malformed case (bad setup key, unreadable tree, a check that throws)
    // is a result, not a crash. Record it and carry on.
    const result: BenchResult = {
      caseId: caseDef.id,
      harness: adapter.id,
      model,
      pass: false,
      checks: [],
      turns: 0,
      wallMs: Date.now() - start,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [],
      diffFiles: [],
      tags: caseDef.tags,
      error: `case failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    if (keep) result.cwd = cwd;
    return result;
  } finally {
    // A locked file (Windows) or a still-dying child must not turn a recorded
    // result into a thrown one, so cleanup failure is swallowed deliberately.
    if (!keep) {
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // left behind in the OS temp dir; harmless and not worth failing a run
      }
    }
  }
}

/** Resolve true/false, treating a hang as false. Used for the availability probe. */
async function withHardTimeout(promise: Promise<boolean>, ms: number, label: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    void label;
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function attempt(
  adapter: HarnessAdapter,
  ctx: BenchRunContext,
  harnessId: string,
): Promise<HarnessOutcome> {
  try {
    return await withTimeout(adapter.run(ctx), ctx.timeoutMs, harnessId);
  } catch (err) {
    return {
      finalText: "",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function applySetup(cwd: string, setup: Record<string, string> | undefined): void {
  if (!setup) return;
  for (const [path, content] of Object.entries(setup)) {
    // Setup keys come from case definitions, which may be loaded from disk.
    // Confine them exactly like the fs tools confine agent-supplied paths.
    const full = confine(cwd, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

/** Resolve `rel` under `root`, refusing absolute paths, `..`, and NUL bytes. */
export function confine(root: string, rel: string): string {
  if (rel.includes("\0")) throw new Error(`invalid path in benchmark case: ${JSON.stringify(rel)}`);
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`absolute path not allowed in benchmark case: ${rel}`);
  }
  const full = resolve(root, rel);
  const rootFull = resolve(root);
  if (full !== rootFull && !full.startsWith(rootFull + sep)) {
    throw new Error(`path escapes the case directory: ${rel}`);
  }
  return full;
}

function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of walk(dir)) {
    try {
      out.set(rel, hashFile(join(dir, rel)));
    } catch {
      out.set(rel, "unreadable");
    }
  }
  return out;
}

function hashFile(path: string): string {
  // Compare by content, not byte size: a rewrite that preserves length must
  // still register as a change, or `untouched()` checks produce false passes.
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const MAX_WALK_DEPTH = 24;

function walk(dir: string, prefix = "", depth = 0): string[] {
  if (depth > MAX_WALK_DEPTH) return [];
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Never traverse symlinks: a case that plants `loop -> .` would otherwise
    // recurse until the stack blows, or walk an entire foreign tree.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      out.push(...walk(join(dir, entry.name), rel, depth + 1));
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function diff(dir: string, before: Map<string, string>): string[] {
  const after = snapshot(dir);
  const changed: string[] = [];
  for (const [rel, hash] of after) {
    const prev = before.get(rel);
    if (prev === undefined || prev !== hash) changed.push(rel);
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changed.push(rel);
  }
  return changed.sort();
}

async function withTimeout(
  promise: Promise<HarnessOutcome>,
  ms: number,
  harnessId: string,
): Promise<HarnessOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<HarnessOutcome>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timeout: harness "${harnessId}" exceeded ${ms}ms`)),
          ms,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
