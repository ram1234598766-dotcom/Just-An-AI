import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export type ModelRole = "coder" | "fast" | "reasoning";
export const MODEL_ROLES: readonly ModelRole[] = ["coder", "fast", "reasoning"];

type PermissionEntry = string | { tool?: string | undefined; command?: string | undefined; path?: string | undefined };

const permissionModeSchema = z.enum(["suggest", "auto-edit", "full-auto"]);

const permissionRuleEntrySchema: z.ZodType<PermissionEntry> = z.union([
  z.string().min(1),
  z
    .object({
      tool: z.string().min(1).optional(),
      command: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
    })
    .refine((o) => o.tool !== undefined || o.command !== undefined || o.path !== undefined, {
      message: "a permission rule needs at least one of tool, command, or path",
    }),
]);

const permissionListSchema = z.array(permissionRuleEntrySchema).default([]);

const permissionBlockSchema = z
  .object({
    mode: permissionModeSchema.default("suggest"),
    allow: permissionListSchema,
    deny: permissionListSchema,
  })
  // A factory, not a shared literal: a shared default would hand the same
  // array to every caller that loads settings, so one mutation would leak
  // into every later load.
  .default((): { mode: "suggest"; allow: []; deny: [] } => ({ mode: "suggest", allow: [], deny: [] }));

export const settingsSchema = z.object({
  defaultProvider: z.string().min(1).optional(),
  /** Base URL for Ollama (local-first default). */
  ollamaBaseUrl: z.string().url().default("http://localhost:11434"),
  /** Model per role. Unset → provider default at call time. */
  models: z
    .object({
      coder: z.string().optional(),
      fast: z.string().optional(),
      reasoning: z.string().optional(),
    })
    .default({}),
  /**
   * Permission rules. Validated here rather than at call time so a typo fails
   * on load with a path-qualified error instead of silently never matching.
   */
  permissions: permissionBlockSchema,
});

export type Settings = z.infer<typeof settingsSchema>;

/** Validate an individual dotted config path + value for `jaa config set`. */
const pathValidators: Record<string, z.ZodType<unknown>> = {
  "defaultProvider": z.string().min(1),
  "ollamaBaseUrl": z.string().url(),
  "models.coder": z.string().min(1),
  "models.fast": z.string().min(1),
  "models.reasoning": z.string().min(1),
  "permissions.mode": z.enum(["suggest", "auto-edit", "full-auto"]),
};

export function configPath(): string {
  return join(process.env.JAA_HOME ?? join(homedir(), ".jaa"), "config.json");
}

export function defaultSettings(): Settings {
  return { ollamaBaseUrl: "http://localhost:11434", models: {}, permissions: { mode: "suggest", allow: [], deny: [] } };
}

export interface SettingsLoadIssue {
  path: string;
  message: string;
}

let lastLoadIssue: SettingsLoadIssue | undefined;

/**
 * The most recent load failure, if any.
 *
 * A config that fails to parse used to be replaced by defaults silently, which
 * quietly discarded every deny rule while leaving the operator believing their
 * policy was in force. Callers must surface this.
 */
export function settingsLoadIssue(): SettingsLoadIssue | undefined {
  return lastLoadIssue;
}

export function loadSettings(): Settings {
  lastLoadIssue = undefined;
  const file = configPath();
  if (!existsSync(file)) return defaultSettings();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    lastLoadIssue = { path: file, message: err instanceof Error ? err.message : String(err) };
    return defaultSettings();
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    lastLoadIssue = { path: file, message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    return defaultSettings();
  }
  const parsed = settingsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    // Fail closed and say so. Silently falling back to defaults here is how a
    // typo ends up removing an operator's deny list.
    lastLoadIssue = {
      path: file,
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .slice(0, 5)
        .join("; "),
    };
    return salvageSettings(parsedJson);
  }
  return parsed.data;
}

/**
 * Rebuild settings field by field.
 *
 * Each permission field is validated independently so a bad `allow` entry
 * cannot take a valid `deny` list down with it. That asymmetry is deliberate:
 * a dropped allow is inconvenient, a dropped deny is a security hole.
 */
function salvageSettings(raw: unknown): Settings {
  const fallback = defaultSettings();
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const perms = obj.permissions;
  if (!perms || typeof perms !== "object" || Array.isArray(perms)) return fallback;

  const pickRules = (value: unknown): PermissionEntry[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const ok: PermissionEntry[] = [];
    let dropped = 0;
    for (const entry of value) {
      const parsed = permissionRuleEntrySchema.safeParse(entry);
      if (parsed.success) ok.push(parsed.data as PermissionEntry);
      else dropped++;
    }
    if (dropped > 0 && lastLoadIssue) {
      lastLoadIssue.message += `; ${dropped} permission entr${dropped === 1 ? "y was" : "ies were"} dropped as invalid`;
    }
    return ok;
  };

  const allow = pickRules((perms as Record<string, unknown>).allow);
  const deny = pickRules((perms as Record<string, unknown>).deny);
  const mode = permissionModeSchema.safeParse((perms as Record<string, unknown>).mode);

  const base: Settings["permissions"] = { mode: mode.success ? mode.data : "suggest", allow: [], deny: [] };
  if (allow !== undefined) base.allow = allow;
  if (deny !== undefined) base.deny = deny;
  return { ...fallback, permissions: base };
}

export function saveSettings(settings: Settings): void {
  writeFileSync(configPath(), JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function getSetting(path: string): { found: boolean; value: unknown } {
  const settings = loadSettings();
  const parts = path.split(".");
  let node: unknown = settings;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return { found: false, value: undefined };
    node = (node as Record<string, unknown>)[part];
    if (node === undefined) return { found: false, value: undefined };
  }
  return { found: true, value: node };
}

/** Validated dotted-path set. Returns the new settings or throws a ZodError. */
export function setSetting(path: string, rawValue: string): Settings {
  const validator = pathValidators[path];
  if (!validator) throw new Error(`no config key named "${path}"`);
  const value = validator.parse(coerce(rawValue, validator));
  const settings = loadSettings();
  const parts = path.split(".");
  let node: unknown = settings;
  for (const part of parts.slice(0, -1)) {
    const existing = (node as Record<string, unknown>)[part];
    if (existing === null || typeof existing !== "object") {
      (node as Record<string, unknown>)[part] = {};
    }
    node = (node as Record<string, unknown>)[part] as unknown;
  }
  (node as Record<string, unknown>)[parts.at(-1) ?? ""] = value;
  saveSettings(settings);
  return settings;
}

function coerce(raw: string, zodType: z.ZodType<unknown>): unknown {
  if (zodType instanceof z.ZodString) return raw;
  if (zodType instanceof z.ZodNumber) {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`expected a number, got "${raw}"`);
    return n;
  }
  return raw;
}