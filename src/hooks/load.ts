import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHookConfig, type ValidatedHookEntry } from "./types.js";

/**
 * Where a hook entry came from, so every decision can be attributed.
 *
 * Layers are applied in order and later layers ADD to earlier ones — they
 * never replace. A deny in a global config is not cancelled by an allow in a
 * project file; both are evaluated and the deny wins, exactly as the
 * permission engine already does.
 */
export type HookSource = "settings" | "agents" | "claude-settings" | "plugin";

export interface LoadedHooks {
  entries: ValidatedHookEntry[];
  sources: { source: HookSource; count: number }[];
  warnings: string[];
}

/** The `hooks` key in `~/.jaa/config.json` — the operator's own layer. */
export function loadSettingsHooks(configPath: string): ValidatedHookEntry[] {
  if (!existsSync(configPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const result = parseHookConfig(hooks);
  return result.ok ? result.entries : [];
}

/**
 * Hooks declared in `AGENTS.md` frontmatter.
 *
 * Always empty. The shared frontmatter parser projects only `name`,
 * `description` and `triggers`, so a `hooks:` key cannot survive the parse, and
 * its YAML subset has no way to represent an array of `{ event, groups }`
 * objects in the first place. Reading `frontmatter.hooks` would mean casting
 * onto a shape the parser never produces, so this layer stays inert until the
 * parser carries unknown keys through.
 *
 * A project's AGENTS.md is untrusted, so once it does work its entries merge
 * without ever widening the operator's own settings.
 */
export function loadAgentsHooks(_agentsPath: string): ValidatedHookEntry[] {
  return [];
}

/**
 * Hooks declared in a project `.claude/settings.json`.
 *
 * Deliberately NOT applied by default: the file lives inside a cloned
 * repository, so honouring it automatically would let any repository
 * inject arbitrary commands into the operator's session. It is detected and
 * reported; the operator opts in with `--trust-project-settings`, exactly as
 * the permission engine already does.
 */
export function loadClaudeSettingsHooks(settingsPath: string): ValidatedHookEntry[] {
  if (!existsSync(settingsPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return [];
  const result = parseHookConfig(hooks);
  return result.ok ? result.entries : [];
}

/**
 * Load hooks from every configured layer, merging later layers into earlier
 * ones. Unknown event names and malformed groups are skipped with a warning
 * rather than rejected, so one bad entry cannot disable the whole chain.
 */
export function loadAllHooks(input: {
  settingsPath: string;
  agentsPath: string;
  claudeSettingsPath: string;
  trustProjectClaudeSettings?: boolean;
  pluginHooks?: ValidatedHookEntry[];
}): LoadedHooks {
  const warnings: string[] = [];
  const entries: ValidatedHookEntry[] = [];
  const sources: { source: HookSource; count: number }[] = [];

  const settings = loadSettingsHooks(input.settingsPath);
  if (settings.length) {
    entries.push(...settings);
    sources.push({ source: "settings", count: settings.length });
  }

  const agents = loadAgentsHooks(input.agentsPath);
  if (agents.length) {
    entries.push(...agents);
    sources.push({ source: "agents", count: agents.length });
  }

  if (input.trustProjectClaudeSettings) {
    const claude = loadClaudeSettingsHooks(input.claudeSettingsPath);
    if (claude.length) {
      entries.push(...claude);
      sources.push({ source: "claude-settings", count: claude.length });
    }
  }

  const plugins = input.pluginHooks ?? [];
  if (plugins.length) {
    entries.push(...plugins);
    sources.push({ source: "plugin", count: plugins.length });
  }

  return { entries, sources, warnings };
}

/** Build the default hook config paths for the current workspace. */
export function defaultHookPaths(cwd: string = process.cwd()): {
  settingsPath: string;
  agentsPath: string;
  claudeSettingsPath: string;
} {
  return {
    settingsPath: join(process.env.JAA_HOME ?? join(homedir(), ".jaa"), "config.json"),
    agentsPath: join(cwd, "AGENTS.md"),
    claudeSettingsPath: join(cwd, ".claude", "settings.json"),
  };
}