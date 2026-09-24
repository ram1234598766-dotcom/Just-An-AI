import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

export type ModelRole = "coder" | "fast" | "reasoning";
export const MODEL_ROLES: readonly ModelRole[] = ["coder", "fast", "reasoning"];

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
});

export type Settings = z.infer<typeof settingsSchema>;

/** Validate an individual dotted config path + value for `jaa config set`. */
const pathValidators: Record<string, z.ZodType<unknown>> = {
  "defaultProvider": z.string().min(1),
  "ollamaBaseUrl": z.string().url(),
  "models.coder": z.string().min(1),
  "models.fast": z.string().min(1),
  "models.reasoning": z.string().min(1),
};

export function configPath(): string {
  return join(process.env.JAA_HOME ?? join(homedir(), ".jaa"), "config.json");
}

export function defaultSettings(): Settings {
  return { ollamaBaseUrl: "http://localhost:11434", models: {} };
}

export function loadSettings(): Settings {
  const file = configPath();
  if (!existsSync(file)) return defaultSettings();
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : defaultSettings();
  } catch {
    return defaultSettings();
  }
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