export const DECISIONS = ["allow", "deny", "ask", "defer"] as const;
export type Decision = (typeof DECISIONS)[number];

export const PERMISSION_MODES = ["suggest", "auto-edit", "full-auto"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type RuleSource = "default" | "settings" | "claude" | "session" | "subagent";

/**
 * A permission rule. Every field present must match for the rule to apply; a
 * rule with no fields is a catch-all. More fields, and longer patterns, mean
 * higher specificity, and the most specific matching rule wins.
 */
export interface Rule {
  decision: Exclude<Decision, "defer">;
  /** Exact tool name or a glob over tool names. */
  tool?: string;
  /** Prefix matched against a shell command on a word boundary. */
  command?: string;
  /** Glob matched against the path a tool is about to touch. */
  path?: string;
  /** Where the rule came from, so every decision can be attributed. */
  source: RuleSource;
}

export interface PermissionRequest {
  tool: string;
  /** Parsed tool arguments. Malformed JSON yields an empty object, not a throw. */
  args: Record<string, unknown>;
  cwd: string;
  root: string;
}

export interface PermissionOutcome {
  decision: Decision;
  reason: string;
  rule?: Rule;
  specificity: number;
}

export interface GateOptions {
  /** False when there is no TTY, which turns every `ask` into a `deny`. */
  interactive: boolean;
  cwd: string;
  root: string;
  /** Optional TTY prompter; injected so tests never touch stdin. */
  prompt?: (request: PermissionRequest, outcome: PermissionOutcome) => Promise<Decision>;
  /** Session grants recorded from earlier "always" answers, checked exactly. */
  grants?: { has(request: PermissionRequest): boolean };
}
