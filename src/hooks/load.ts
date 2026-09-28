import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseHookConfigResilient, type ValidatedHookEntry } from "./types.js";

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
  /**
   * Why a layer is not in force exactly as written: entries the validator
   * rejected, and layers it could not read at all. Never empty when something
   * was dropped — a hook that quietly does not run is the failure mode this
   * exists to end.
   */
  warnings: string[];
}

/** One layer's outcome: the entries that load, and what was wrong with the rest. */
interface HookLayer {
  entries: ValidatedHookEntry[];
  warnings: string[];
}

/** A fresh empty layer, so no two callers share one mutable result. */
function emptyLayer(): HookLayer {
  return { entries: [], warnings: [] };
}

/**
 * Report a layer's rejected entries in the shape the CLI already uses for a
 * layer it could not load (`hookConfigErrors` in `src/cli/index.ts`): a
 * summary naming the file, then the validator's own message per entry, each
 * indented under it. One format on both sides, so `jaa hooks list` and a run
 * cannot describe the same typo two different ways — and the wording is the
 * CLI's, not a second invention.
 */
function formatLayerWarning(label: string, errors: string[]): string {
  return [`${label}: ${errors.length} invalid hook entry/entries`, ...errors.map((error) => `  ${error}`)].join("\n");
}

/**
 * Read the `hooks` key of a JSON config file — the shape both `~/.jaa/config.json`
 * and a project `.claude/settings.json` use.
 *
 * Malformed entries do not take the layer down with them: everything that
 * validates is loaded and everything that does not is reported, so one broken
 * handler cannot silently disarm a deny rule sitting in the same file.
 */
function readJsonHookLayer(path: string, label: string): HookLayer {
  if (!existsSync(path)) return emptyLayer();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A file that is not JSON is diagnosed by the CLI, which names the file and
    // the parse error. Nothing about hook config was readable here, so the
    // loader has nothing to report of its own and does not restate it.
    return emptyLayer();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyLayer();
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (hooks === undefined) return emptyLayer();
  const layer = parseHookConfigResilient(hooks);
  return {
    entries: layer.entries,
    warnings: layer.errors.length > 0 ? [formatLayerWarning(label, layer.errors)] : [],
  };
}

/** The `hooks` key in `~/.jaa/config.json` — the operator's own layer. */
export function loadSettingsHooks(configPath: string): ValidatedHookEntry[] {
  return readJsonHookLayer(configPath, "~/.jaa/config.json").entries;
}

/**
 * What a project AGENTS.md contributes, if anything.
 *
 * Always no entries, but no longer silent. `parseFrontmatter` in
 * `src/skills/loader.ts` projects only `name`, `description` and `triggers`, so
 * a `hooks:` key cannot survive that parse, and its YAML subset — top-level
 * scalars and flat `- item` lists, no nesting — has no way to express
 * `[{ event, groups: [{ handlers: [...] }] }]`. Reading `frontmatter.hooks`
 * would mean casting onto a shape the parser never produces, so the layer stays
 * empty.
 *
 * Carrying it would mean teaching that parser nested YAML, which is a change to
 * the shared skills parser and out of scope here. Until then the file is read
 * for a `hooks:` key and the operator is told plainly that it is being ignored,
 * rather than left believing their hooks are armed.
 *
 * When it does work, these entries are untrusted (a project's AGENTS.md is not
 * the operator's) and must merge without ever widening the operator's own
 * settings.
 */
function readAgentsLayer(agentsPath: string): HookLayer {
  if (!existsSync(agentsPath)) return emptyLayer();
  let raw: string;
  try {
    raw = readFileSync(agentsPath, "utf8");
  } catch {
    return emptyLayer();
  }
  const block = frontmatterBlock(raw);
  if (block === undefined || !declaresTopLevelKey(block, "hooks")) return emptyLayer();
  return {
    entries: [],
    warnings: [
      "AGENTS.md: a `hooks:` key in the frontmatter is NOT read — the frontmatter parser carries only " +
        "name/description/triggers, and its YAML subset cannot express nested hook groups, so no hook was " +
        "loaded from this file. Declare hooks in ~/.jaa/config.json (or .claude/settings.json) instead.",
    ],
  };
}

/**
 * The raw frontmatter block of a markdown file, without its `---` fences.
 *
 * The opening fence is the first line; the block ends at the first `---` after
 * it, so a `---` rule in the body does not swallow the body into the frontmatter
 * (the skills parser closes on the *last* one, which is why this cannot simply
 * reuse its result). The text is needed raw because `parseFrontmatter` projects
 * three keys and discards the rest, so it cannot be asked whether a `hooks:` key
 * is present.
 */
function frontmatterBlock(text: string): string | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return undefined;
  const close = lines.indexOf("---", 1);
  if (close === -1) return undefined;
  return lines.slice(1, close).join("\n");
}

/** Whether a frontmatter block declares `key` at the top level (no indent). */
function declaresTopLevelKey(block: string, key: string): boolean {
  return block.split("\n").some((line) => new RegExp(`^${key}\\s*:`).test(line));
}

/**
 * Hooks declared in `AGENTS.md` frontmatter.
 *
 * No entries today, for the reason `readAgentsLayer` records; `loadAllHooks`
 * reports the limitation when a `hooks:` key is actually present.
 */
export function loadAgentsHooks(agentsPath: string): ValidatedHookEntry[] {
  return readAgentsLayer(agentsPath).entries;
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
  return readJsonHookLayer(settingsPath, ".claude/settings.json").entries;
}

/**
 * Load hooks from every configured layer, merging later layers into earlier
 * ones.
 *
 * Resilience, precisely: a malformed *group* or *handler* is skipped, named in
 * `warnings`, and leaves its siblings in the same event loaded — a broken
 * handler can no longer take a valid deny rule down with it. Two things stay
 * all-or-nothing, because nothing under them is salvageable: a layer whose
 * `hooks` value is not an object, and an event key whose value is not a
 * non-empty array of groups. Unknown event names are skipped silently so a
 * config written against a newer jaa still loads, as they always have.
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

  const settings = readJsonHookLayer(input.settingsPath, "~/.jaa/config.json");
  warnings.push(...settings.warnings);
  if (settings.entries.length) {
    entries.push(...settings.entries);
    sources.push({ source: "settings", count: settings.entries.length });
  }

  // Read for the warning only: the layer yields no entries today, so there is no
  // `agents` source to record. If the frontmatter parser ever carries hooks
  // through, this is the line that has to come back.
  const agents = readAgentsLayer(input.agentsPath);
  warnings.push(...agents.warnings);

  if (input.trustProjectClaudeSettings) {
    const claude = readJsonHookLayer(input.claudeSettingsPath, ".claude/settings.json");
    warnings.push(...claude.warnings);
    if (claude.entries.length) {
      entries.push(...claude.entries);
      sources.push({ source: "claude-settings", count: claude.entries.length });
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