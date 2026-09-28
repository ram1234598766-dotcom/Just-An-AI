import type { HookGroup, HookMatcher } from "./types.js";

/**
 * Resolve a matcher string into a structured matcher.
 *
 * Mirrors Claude Code's rules:
 *   "*", "", or omitted  → match all
 *   only [A-Za-z0-9_\- ,|] → exact, or a |-separated list
 *   anything else         → unanchored JS regex
 */
export function parseMatcher(value: string | undefined): HookMatcher {
  if (value === undefined || value === "" || value === "*") {
    return { type: "all" };
  }
  if (/^[A-Za-z0-9_\- ,|]+$/.test(value)) {
    const parts = value.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return { type: "all" };
    if (parts.length === 1) return { type: "exact", value: parts[0]! };
    return { type: "list", values: parts };
  }
  return { type: "regex", pattern: value };
}

/** True when `value` matches `matcher`. */
export function matcherMatches(matcher: HookMatcher, value: string): boolean {
  switch (matcher.type) {
    case "all":
      return true;
    case "exact":
      return value === matcher.value;
    case "list":
      return matcher.values.includes(value);
    case "regex": {
      try {
        return new RegExp(matcher.pattern).test(value);
      } catch {
        // A broken regex matches nothing — a malformed matcher is a no-op,
        // not a silent match-all.
        return false;
      }
    }
  }
}

/** The field a group's matcher filters on, by event. */
export function matcherField(event: string): "toolName" | "agentType" | "startupSource" | "all" {
  if (event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" || event === "PermissionRequest") {
    return "toolName";
  }
  if (event === "SubagentStart" || event === "SubagentStop") return "agentType";
  if (event === "SessionStart") return "startupSource";
  return "all";
}

/**
 * Evaluate a group's `if` filter (Claude Code permission-rule syntax:
 * `Bash(rm *)`, `Edit(*.ts)`, bare tool names). Returns true when the filter
 * does not apply, so a group without an `if` always fires.
 */
export function ifFilterApplies(group: HookGroup, payload: { toolName?: string; toolInput?: Record<string, unknown> }): boolean {
  const filter = group.if;
  if (filter === undefined) return true;
  const trimmed = filter.trim();
  const match = /^([A-Za-z_]+)\((.*)\)$/.exec(trimmed);

  if (!match) {
    // Bare tool name: matches only tool events for that tool.
    return payload.toolName === trimmed;
  }

  const tool = match[1]!;
  const arg = (match[2] ?? "").trim();
  if (payload.toolName !== tool) return false;
  if (arg === "" || arg === "*") return true;

  // `Bash(git status:*)` — the `:*` suffix marks a command prefix.
  if (arg.endsWith(":*")) {
    const prefix = arg.slice(0, -2).trim();
    if (prefix === "") return true;
    return commandPrefixMatches(payload.toolInput, prefix);
  }

  // Otherwise the argument is a glob over the tool's primary string field.
  return globMatches(payload.toolInput, arg);
}

function commandPrefixMatches(input: Record<string, unknown> | undefined, prefix: string): boolean {
  const command = typeof input?.command === "string" ? input.command : "";
  return command.toLowerCase().startsWith(prefix.toLowerCase());
}

function globMatches(input: Record<string, unknown> | undefined, glob: string): boolean {
  const value = typeof input?.command === "string" ? input.command : typeof input?.path === "string" ? input.path : "";
  if (value === "") return false;
  return globToRegExp(glob).test(value);
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === undefined) continue;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  out += "$";
  return new RegExp(out, "i");
}