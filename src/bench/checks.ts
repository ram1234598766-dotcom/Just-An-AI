import { existsSync, readFileSync } from "node:fs";
import { confine } from "./runner.js";
import type { BenchCase, BenchCheck, BenchTag } from "./types.js";

function safeJoin(cwd: string, path: string): string | undefined {
  try {
    return confine(cwd, path);
  } catch {
    return undefined;
  }
}

export function fileExists(path: string): BenchCheck {
  return (result) => {
    if (!result.cwd) return false;
    const full = safeJoin(result.cwd, path);
    return full !== undefined && existsSync(full);
  };
}

export function fileAbsent(path: string): BenchCheck {
  return (result) => {
    if (!result.cwd) return false;
    const full = safeJoin(result.cwd, path);
    if (full === undefined) return false;
    return !existsSync(full);
  };
}

export function fileContains(path: string, needle: string | RegExp): BenchCheck {
  return (result) => {
    if (!result.cwd) return false;
    const full = safeJoin(result.cwd, path);
    if (full === undefined || !existsSync(full)) return false;
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      return false;
    }
    return test(needle, content);
  };
}

export function fileLineCountAtLeast(path: string, min: number): BenchCheck {
  return (result) => {
    if (!result.cwd) return false;
    const full = safeJoin(result.cwd, path);
    if (full === undefined || !existsSync(full)) return false;
    try {
      const lines = readFileSync(full, "utf8").split("\n").filter((l) => l.trim().length > 0);
      return lines.length >= min;
    } catch {
      return false;
    }
  };
}

/**
 * Test a string against a literal or pattern.
 *
 * A `/g` or `/y` pattern carries `lastIndex` between calls, and one check
 * closure is reused across every harness x result in the matrix, so a
 * stateful pattern would alternate pass and fail. Reset before testing.
 */
function test(needle: string | RegExp, text: string): boolean {
  if (typeof needle === "string") return text.includes(needle);
  needle.lastIndex = 0;
  return needle.test(text);
}

export function finalContains(needle: string | RegExp): BenchCheck {
  return (result) => test(needle, result.finalText ?? "");
}

export function finalMatches(pattern: RegExp): BenchCheck {
  return (result) => test(pattern, result.finalText ?? "");
}

export function finalLacks(needle: string | RegExp): BenchCheck {
  return (result) => !test(needle, result.finalText ?? "");
}

export function toolCalled(name: string): BenchCheck {
  return (result) => result.toolCalls.some((c) => c.name === name);
}

export function notToolCalled(name: string): BenchCheck {
  return (result) => !result.toolCalls.some((c) => c.name === name);
}

export function toolCalledAtLeast(name: string, min: number): BenchCheck {
  return (result) => result.toolCalls.filter((c) => c.name === name).length >= min;
}

export function turnsAtMost(max: number): BenchCheck {
  return (result) => result.turns <= max;
}

export function turnsAtLeast(min: number): BenchCheck {
  return (result) => result.turns >= min;
}

export function touched(path: string): BenchCheck {
  return (result) => result.diffFiles.includes(path);
}

export function untouched(path: string): BenchCheck {
  return (result) => !result.diffFiles.includes(path);
}

export function errored(): BenchCheck {
  return (result) => result.error !== undefined;
}

export function noError(): BenchCheck {
  return (result) => result.error === undefined;
}

export function all(...checks: BenchCheck[]): BenchCheck {
  return (result) => checks.every((c) => c(result));
}

export function any(...checks: BenchCheck[]): BenchCheck {
  return (result) => checks.some((c) => c(result));
}

export function caseOf(
  id: string,
  prompt: string,
  tags: BenchTag[],
  checks: BenchCheck[],
  opts: Partial<Omit<BenchCase, "id" | "prompt" | "tags" | "checks">> = {},
): BenchCase {
  return {
    id,
    prompt,
    tags,
    checks: checks.map((check, i) => ({ name: `check-${i}`, check })),
    ...(opts.setup !== undefined ? { setup: opts.setup } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}
