import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseDotenv } from "dotenv";

/** Which layer provided a given config key. */
export type SecretSource = "process" | "project" | "home";

export interface SecretRef {
  value: string;
  source: SecretSource;
}

function jaaHome(): string {
  return process.env.JAA_HOME ?? join(homedir(), ".jaa");
}

function layerVars(vars: Record<string, string | undefined> | null | undefined): Record<string, string> | null {
  if (!vars) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function envFileIfPresent(path: string | undefined): string | undefined {
  return path && existsSync(path) ? path : undefined;
}

/**
 * Layered env view WITHOUT mutating process.env. Precedence (highest first):
 * process.env > project `.env` > `~/.jaa/.env`. Sources are tracked per key so
 * `jaa doctor` can report where a value came from.
 */
export class EnvLayers {
  private readonly view = new Map<string, SecretRef>();

  constructor(projectDir = "", homeEnvFile?: string) {
    this.add("process", layerVars(process.env));
    this.add("project", this.readLayer(join(projectDir ?? "", ".env")));
    this.add("home", this.readLayer(homeEnvFile));
  }

  private readLayer(file: string | undefined): Record<string, string> | null {
    if (!file || !existsSync(file)) return null;
    try {
      return layerVars(parseDotenv(readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  private add(source: SecretSource, vars: Record<string, string> | null) {
    if (!vars) return;
    for (const [key, value] of Object.entries(vars)) {
      if (!this.view.has(key)) this.view.set(key, { value, source });
    }
  }

  get(key: string): SecretRef | undefined {
    return this.view.get(key);
  }

  has(key: string): boolean {
    return this.view.has(key);
  }

  /** All keys (names only — never values) for diagnostics. */
  keys(): { key: string; source: SecretSource }[] {
    return [...this.view.entries()].map(([key, ref]) => ({ key, source: ref.source }));
  }
}

let cached: EnvLayers | null = null;

export function envLayers(): EnvLayers {
  if (!cached) {
    cached = new EnvLayers(process.cwd(), envFileIfPresent(join(jaaHome(), ".env")));
  }
  return cached;
}

/** Test / config-change hook: force a re-read from disk on next access. */
export function resetEnvLayers(): void {
  cached = null;
}

/** Convenience: first match among candidate env keys, with source. */
export function findSecret(candidates: string[]): SecretRef | undefined {
  const layers = envLayers();
  for (const key of candidates) {
    const ref = layers.get(key);
    if (ref) return ref;
  }
  return undefined;
}