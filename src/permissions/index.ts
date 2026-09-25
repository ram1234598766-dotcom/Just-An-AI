export { DECISIONS, PERMISSION_MODES } from "./types.js";
export type {
  Decision,
  GateOptions,
  PermissionMode,
  PermissionOutcome,
  PermissionRequest,
  Rule,
  RuleSource,
} from "./types.js";
export {
  defaultRules,
  describeRule,
  importClaudeSettings,
  isPermissionMode,
  isReadOnlyTool,
  MUTATING_TOOLS,
  NEVER_IMPLICITLY_ALLOWED,
  READ_ONLY_TOOLS,
  ruleMatches,
  ruleSpecificity,
} from "./rules.js";
export { createEngine, createPermissionGate, resolveDecision, ruleFromSetting } from "./engine.js";
export type { Engine } from "./engine.js";
export { askOnTty, sanitizeForDisplay, SessionGrants } from "./ask.js";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadSettings } from "../config/settings.js";
import { createEngine, ruleFromSetting } from "./engine.js";
import { defaultRules, importClaudeSettings } from "./rules.js";
import type { Engine } from "./engine.js";
import type { PermissionMode, Rule } from "./types.js";

export interface ResolveInput {
  mode?: PermissionMode;
  settings?: { permissions?: { mode?: PermissionMode; allow?: unknown[]; deny?: unknown[] } };
  /** Extra rules, e.g. from a subagent's narrowed declaration. */
  extra?: Rule[];
  /**
   * Apply a `.claude/settings.json` found in the working directory. Off by
   * default: that file lives inside a cloned repository, so honouring it
   * automatically would let any repository widen the operator's permissions.
   */
  trustProjectClaudeSettings?: boolean;
}

export interface ResolvedPolicy {
  engine: Engine;
  mode: PermissionMode;
  rules: Rule[];
  /** A project policy file was found. Reported so it is never silent. */
  projectPolicyFound: boolean;
  projectPolicyApplied: boolean;
}

/**
 * Build the engine for a session.
 *
 * Rule order matters only for reporting, since deny is absolute. A project
 * `.claude/settings.json` is detected but NOT applied unless explicitly
 * trusted: the global `~/.claude/settings.json` is written by the operator,
 * while the project file is written by whoever authored the repository, and a
 * permission system must never let the latter grant capabilities.
 */
export function resolveEngine(input: ResolveInput = {}): ResolvedPolicy {
  // Load settings here rather than accepting them from the caller: every
  // earlier call site forgot to pass them, which silently disabled every
  // user-authored rule. Loading centrally makes that impossible to repeat.
  const settings = input.settings ?? safeLoadSettings();
  const mode = input.mode ?? settings?.permissions?.mode ?? "suggest";
  const rules: Rule[] = [...defaultRules(mode)];

  for (const raw of settings?.permissions?.deny ?? []) {
    rules.push(ruleFromSetting(raw as string | { tool?: string }, "deny"));
  }
  for (const raw of settings?.permissions?.allow ?? []) {
    rules.push(ruleFromSetting(raw as string | { tool?: string }, "allow"));
  }

  const projectPolicyFound = existsSync(projectClaudeSettingsPath());
  const projectPolicyApplied = projectPolicyFound && input.trustProjectClaudeSettings === true;
  if (projectPolicyApplied) {
    rules.push(...importClaudeSettings(readClaudeSettings()));
  }
  rules.push(...(input.extra ?? []));

  return { engine: createEngine(rules), mode, rules, projectPolicyFound, projectPolicyApplied };
}

function safeLoadSettings(): ResolveInput["settings"] {
  try {
    return loadSettings();
  } catch {
    return undefined;
  }
}

function readClaudeSettings(): unknown {
  const path = projectClaudeSettingsPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Project-scoped policy file, which lives inside an untrusted checkout. */
export function projectClaudeSettingsPath(): string {
  return join(process.cwd(), ".claude", "settings.json");
}

/** Operator-written global policy file. */
export function globalClaudeSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json");
}
