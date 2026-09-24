import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderDef } from "./providers.js";

const KEYRING_HOME = () => process.env.JAA_HOME ?? join(homedir(), ".jaa");

function envFile(): string {
  return join(KEYRING_HOME(), ".env");
}

/**
 * Best-effort restrictive permissions (mode 0600). Real ACLs on Windows are the
 * OS's job; this at least keeps POSIX installs locked down.
 */
function restrictPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: chmod is a no-op; nothing to do.
  }
}

/**
 * Reads the keyring as raw KEY=value lines (intentionally NOT dotenv-parsed, so
 * secret values with stray `#` or interpolation markers survive untouched).
 */
export function readKeyring(): Map<string, string> {
  const file = envFile();
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const eq = raw.indexOf("=");
    if (raw.trim() === "" || raw.startsWith("#") || eq <= 0) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (key.startsWith("JAA_")) out.set(key, value);
  }
  return out;
}

function writeKeyring(entries: Map<string, string>): void {
  const lines = [...entries.entries()].map(([k, v]) => `${k}=${v}`);
  writeFileSync(envFile(), lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  restrictPermissions(envFile());
}

export function setKey(def: ProviderDef, value: string): void {
  const entries = readKeyring();
  entries.set(def.keyringEnv, value);
  writeKeyring(entries);
}

export function removeKey(def: ProviderDef): boolean {
  const entries = readKeyring();
  const removed = entries.delete(def.keyringEnv);
  if (removed) writeKeyring(entries);
  return removed;
}

export function hasKey(def: ProviderDef): boolean {
  return readKeyring().has(def.keyringEnv);
}

/** { id, provider, masked } for `jaa key list`. Never returns the value. */
export interface KeyMeta {
  id: string;
  provider: string;
  masked: string;
}

export function listKeyMeta(): KeyMeta[] {
  const entries = readKeyring();
  return [...entries.entries()].map(([env, value]) => ({
    id: env,
    provider: env.replace(/^JAA_(.+)_API_KEY$/, "$1").toLowerCase(),
    masked: maskSecret(value),
  }));
}

/** Shows only a trailing fragment of a secret. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  const tail = value.slice(-4);
  return "****" + tail;
}