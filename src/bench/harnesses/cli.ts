import { spawn } from "node:child_process";
import type { HarnessAdapter, HarnessOutcome, BenchRunContext } from "../types.js";

export interface ExternalHarnessOptions {
  id: string;
  bin: string;
  /** Arguments after the binary. Use `{{prompt}}` / `{{cwd}}` / `{{model}}` placeholders. */
  args: string[];
  /** Milliseconds to allow the child to exit after the context deadline. */
  killGraceMs?: number;
}

const PRESETS: Record<string, { bin: string; args: string[] }> = {
  claude: { bin: "claude", args: ["-p", "{{prompt}}", "--model", "{{model}}", "--output-format", "json"] },
  codex: { bin: "codex", args: ["exec", "{{prompt}}", "--output", "json", "-C", "{{cwd}}"] },
  // No --print-logs: logs share stdout with the JSON payload we must parse.
  opencode: { bin: "opencode", args: ["run", "{{prompt}}", "--model", "{{model}}"] },
  dsh: { bin: "dsh", args: ["run", "{{prompt}}", "--json"] },
};

export const defaultExternalTemplates: Readonly<Record<string, { bin: string; args: string[] }>> = PRESETS;

export function knownExternalHarnesses(): string[] {
  return Object.keys(PRESETS);
}

const MAX_STDOUT = 2_000_000;
const MAX_STDERR = 200_000;

export function externalHarness(options: ExternalHarnessOptions): HarnessAdapter {
  const killGrace = options.killGraceMs ?? 2_000;
  let probe: Promise<boolean> | undefined;
  return {
    id: options.id,
    available() {
      // Probe once per harness, not once per case: a 46-case matrix would
      // otherwise spawn 46 `--version` processes per competitor.
      probe ??= new Promise<boolean>((resolve) => {
        const child = spawn(options.bin, ["--version"], { stdio: "ignore", shell: false });
        let settled = false;
        const timer = setTimeout(() => done(false), 5_000);
        timer.unref?.();
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (!ok) child.kill("SIGKILL");
          resolve(ok);
        };
        child.on("error", () => done(false));
        child.on("close", (code) => done(code === 0));
      });
      return probe;
    },
    run(ctx: BenchRunContext): Promise<HarnessOutcome> {
      return runExternal(options, ctx, killGrace);
    },
  };
}

function fill(template: string, ctx: BenchRunContext): string {
  return template
    .replaceAll("{{prompt}}", ctx.caseDef.prompt)
    .replaceAll("{{cwd}}", ctx.cwd)
    .replaceAll("{{model}}", ctx.model);
}

function runExternal(
  options: ExternalHarnessOptions,
  ctx: BenchRunContext,
  killGraceMs: number,
): Promise<HarnessOutcome> {
  return new Promise<HarnessOutcome>((resolve) => {
    const args = options.args.map((a) => fill(a, ctx));
    const child = spawn(options.bin, args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // settle() resolves the caller but deliberately does NOT clear killTimer.
    // If the child ignores SIGTERM we must still SIGKILL it after the grace
    // period, otherwise it is orphaned and keeps writing into a directory the
    // runner is about to delete.
    const settle = (outcome: HarnessOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(outcome);
    };

    const killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, ctx.timeoutMs + killGraceMs);
    killTimer.unref?.();

    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      settle({
        finalText: "",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        error: `timeout: "${options.id}" exceeded ${ctx.timeoutMs}ms`,
      });
    }, ctx.timeoutMs);
    deadline.unref?.();

    child.stdout?.on("data", (d: Buffer) => {
      // Hard-cap the retained buffer, not just the process: a child that
      // ignores SIGTERM must not be able to grow our heap without bound.
      if (stdout.length >= MAX_STDOUT) return;
      stdout += d.toString("utf8");
      if (stdout.length > MAX_STDOUT) {
        stdout = stdout.slice(0, MAX_STDOUT);
        child.kill("SIGTERM");
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length >= MAX_STDERR) return;
      stderr += d.toString("utf8");
      if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
    });

    child.on("error", (err: Error) => {
      clearTimeout(killTimer);
      settle({
        finalText: "",
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        error: `spawn failed: ${err.message}`,
      });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (settled) return;
      const text = extractJson(stdout);
      if (text === undefined) {
        settle({
          finalText: "",
          turns: 0,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          toolCalls: [],
          error:
            code !== 0
              ? `exit ${code ?? "null"}: ${stderr.trim().slice(0, 500) || "no stderr"}`
              : "unparseable output: no JSON object found in harness stdout",
        });
        return;
      }
      settle(normalize(text));
    });
  });
}

/**
 * Pull the most plausible JSON object out of arbitrary harness stdout.
 *
 * Handles the shapes competitors actually emit: a single object, NDJSON/JSONL
 * (`codex exec --output json` prints one object per line), and objects
 * preceded by human-readable warnings. Brace counting is string- and
 * escape-aware, so a `}` inside a quoted value does not end the object early.
 */
export function extractJson(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [];
  // NDJSON / JSONL: prefer the last complete line, then the first.
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of [...lines].reverse()) candidates.push(line);
  // Whole payload, in case it is pretty-printed across lines.
  candidates.push(trimmed);
  // Balanced scan, preferring the last complete top-level object.
  const balanced = scanBalancedObjects(trimmed);
  for (const obj of [...balanced].reverse()) candidates.push(obj);

  for (const c of candidates) {
    const parsed = tryParseObject(c);
    if (parsed) return parsed;
  }
  return undefined;
}

function tryParseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // try the next candidate
  }
  return undefined;
}

function scanBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          out.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalize(obj: Record<string, unknown>): HarnessOutcome {
  const rawText =
    (typeof obj.result === "string" && obj.result) ||
    (typeof obj.output === "string" && obj.output) ||
    (typeof obj.text === "string" && obj.text) ||
    (typeof obj.response === "string" && obj.response) ||
    (typeof obj.finalText === "string" && obj.finalText) ||
    (typeof obj.message === "string" && obj.message) ||
    "";

  const toolCalls: { name: string }[] = [];
  const rawCalls = obj.toolCalls ?? obj.tools_used ?? obj.tool_calls;
  if (Array.isArray(rawCalls)) {
    for (const c of rawCalls) {
      if (typeof c === "string") toolCalls.push({ name: c });
      else if (c && typeof c === "object") {
        const name = (c as Record<string, unknown>).name;
        if (typeof name === "string") toolCalls.push({ name });
      }
    }
  }

  const usage = (obj.usage ?? {}) as Record<string, unknown>;

  return {
    finalText: rawText,
    turns: num(obj.turns ?? obj.num_turns),
    inputTokens: num(obj.inputTokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    outputTokens: num(obj.outputTokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
    costUsd: num(obj.costUsd ?? obj.cost_usd ?? obj.total_cost_usd),
    toolCalls,
  };
}
