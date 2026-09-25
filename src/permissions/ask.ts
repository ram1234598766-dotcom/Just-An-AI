import { createInterface } from "node:readline/promises";
import type { Decision, PermissionOutcome, PermissionRequest } from "./types.js";

/**
 * Session-scoped grants, keyed by the exact tool plus the exact argument the
 * operator was shown and approved. "Always" is deliberately exact-match: a
 * prefix grant would silently widen, so approving `rm -rf build` must not also
 * approve `rm -rf build --no-preserve-root /`.
 */
export class SessionGrants {
  private readonly grants = new Set<string>();

  add(request: PermissionRequest): void {
    this.grants.add(grantKey(request));
  }

  has(request: PermissionRequest): boolean {
    return this.grants.has(grantKey(request));
  }

  list(): string[] {
    return [...this.grants].sort();
  }

  clear(): void {
    this.grants.clear();
  }
}

function grantKey(request: PermissionRequest): string {
  // Hash every argument, not just command/path. A grant for one `fetch_url`
  // must not silently cover a later request to a different URL, and a grant
  // for a benign patch must not cover a different hunk set on the same file.
  const args = Object.keys(request.args)
    .sort()
    .map((k) => [k, request.args[k]] as const);
  return JSON.stringify([request.tool, args]);
}

/**
 * Strip C0/C1 control characters and bound the length.
 *
 * The consent prompt renders model-supplied strings straight into the operator's
 * terminal. Without this, a prompt-injected command containing ANSI escapes
 * could repaint the line to read `echo SAFE-SETUP-STEP` while executing
 * something else entirely.
 */
export function sanitizeForDisplay(value: string, max = 200): string {
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, (ch) =>
    ch === "\n" || ch === "\t" ? " " : "",
  );
  return stripped.length > max ? `${stripped.slice(0, max)}...` : stripped;
}

/**
 * Ask the operator. Returns `deny` on any non-answer, EOF, or interrupt, so a
 * closed stdin can never be read as consent.
 */
export async function askOnTty(
  request: PermissionRequest,
  outcome: PermissionOutcome,
  grants: SessionGrants,
): Promise<Decision> {
  // The interface must outlive the answer. Closing it in a `finally` that runs
  // before the promise settles hangs the session forever.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${renderPrompt(request, outcome)} [y]es / [n]o / [a]lways this exact call / [d]efer: `);
    const normalized = answer.trim().toLowerCase();
    if (normalized === "y" || normalized === "yes") return "allow";
    if (normalized === "a" || normalized === "always") {
      grants.add(request);
      return "allow";
    }
    if (normalized === "d" || normalized === "defer") return "defer";
    return "deny";
  } catch {
    // stdin closed, interrupted, or the terminal went away: never consent.
    return "deny";
  } finally {
    rl.close();
  }
}

function renderPrompt(request: PermissionRequest, outcome: PermissionOutcome): string {
  const lines = ["", "  Permission required", `    tool:    ${sanitizeForDisplay(request.tool, 60)}`];
  const command = typeof request.args.command === "string" ? request.args.command : undefined;
  const path = typeof request.args.path === "string" ? request.args.path : undefined;
  if (command !== undefined) lines.push(`    command: ${sanitizeForDisplay(command)}`);
  if (path !== undefined) lines.push(`    path:    ${sanitizeForDisplay(path)}`);
  lines.push(`    reason:  ${sanitizeForDisplay(outcome.reason, 300)}`, "");
  return lines.join("\n");
}
