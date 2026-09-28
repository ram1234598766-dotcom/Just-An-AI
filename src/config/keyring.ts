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

/**
 * The KEY of a `KEY=value` line, or undefined for a blank line, a comment, or
 * anything else that is not an assignment. Mirrors `readKeyring`'s own parse so
 * that a line one function can read is also a line the other can rewrite —
 * two different notions of "a line" is how a rewrite starts dropping entries.
 */
function assignmentKey(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return undefined;
  return trimmed.slice(0, eq).trim();
}

/**
 * The keyring file split into lines, with the empty tail element a trailing
 * newline produces removed — so the array is exactly the file's lines and a
 * round trip is byte-for-byte, CRLF included (the `\r` stays inside the line it
 * belongs to, because the split is on `\n` alone).
 */
function readLines(): { lines: string[]; finalNewline: boolean } {
  const file = envFile();
  if (!existsSync(file)) return { lines: [], finalNewline: true };
  const raw = readFileSync(file, "utf8");
  if (raw === "") return { lines: [], finalNewline: true };
  const lines = raw.split("\n");
  const finalNewline = raw.endsWith("\n");
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

function writeLines(lines: string[], finalNewline: boolean): void {
  writeFileSync(envFile(), lines.join("\n") + (finalNewline ? "\n" : ""), "utf8");
  restrictPermissions(envFile());
}

/**
 * Sets one key, touching exactly one line.
 *
 * ## Why this is line-based and not entry-based
 *
 * The previous version round-tripped the file through `readKeyring()`, which
 * deliberately sees only `JAA_`-prefixed assignments. Writing that map back
 * therefore meant the file was *rebuilt from the subset jaa understands*: a
 * `GITHUB_TOKEN=` line a user had added by hand, a comment explaining it, a
 * blank line, anything at all — all gone on the first `setKey`, with no error
 * and no way back. The file jaa owns and the file the user owns had become the
 * same file by accident.
 *
 * So the unit of writing is the line, not the entry. Everything this function
 * does not own is copied through untouched: other keys, foreign namespaces,
 * comments, ordering, blank lines and line endings. A key jaa did not write is
 * a key jaa does not rewrite, and the only way one disappears is `removeKey`.
 */
function setKeyLine(key: string, value: string): void {
  const { lines, finalNewline } = readLines();
  const replacement = `${key}=${value}`;
  // The LAST occurrence, because that is the one `readKeyring` reports: its Map
  // keeps the last write of a duplicated key, so rewriting an earlier copy would
  // leave the value the file already claims to hold untouched.
  const at = lines.findLastIndex((line) => assignmentKey(line) === key);
  if (at === -1) lines.push(replacement);
  else lines[at] = replacement;
  writeLines(lines, finalNewline);
}

/** Drops every line for `key`. Returns whether anything was removed. */
function removeKeyLine(key: string): boolean {
  const { lines, finalNewline } = readLines();
  const kept = lines.filter((line) => assignmentKey(line) !== key);
  if (kept.length === lines.length) return false;
  writeLines(kept, finalNewline);
  return true;
}

export function setKey(def: ProviderDef, value: string): void {
  setKeyLine(def.keyringEnv, value);
}

export function removeKey(def: ProviderDef): boolean {
  return removeKeyLine(def.keyringEnv);
}

export function hasKey(def: ProviderDef): boolean {
  return readKeyring().has(def.keyringEnv);
}

/**
 * The `JAA_<ID>_API_KEY` / `JAA_<ID>_TOKEN` suffix, unwrapped to `<id>`.
 *
 * Both spellings exist because the file also holds non-provider credentials:
 * `JAA_GITHUB_TOKEN` is not an API key for any provider in the registry, and
 * before this accepted `_TOKEN` it reported a "provider" of `jaa_github_token`
 * and never matched the id it is stored under, so `jaa key list` could not show
 * a token the user had explicitly configured.
 *
 * The suffix sits OUTSIDE the capture group, which is the whole point: put it
 * inside and `$1` is the id *plus* the suffix, so `JAA_OPENAI_API_KEY` reports
 * `openai_api_key`. The dot is lazy, which here is equivalent to greedy — the
 * suffix is anchored at the end of the string, so there is only ever one place
 * it can match — while making the intent explicit: stop at the first suffix.
 */
const KEYRING_ID = /^JAA_(.+?)_(?:API_KEY|TOKEN)$/;

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
    provider: env.replace(KEYRING_ID, "$1").toLowerCase(),
    masked: maskSecret(value),
  }));
}

/** Shows only a trailing fragment of a secret. */
export function maskSecret(value: string): string {
  if (value.length <= 4) return "****";
  const tail = value.slice(-4);
  return "****" + tail;
}