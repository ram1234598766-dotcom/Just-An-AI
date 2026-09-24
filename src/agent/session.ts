/**
 * Session persistence — a session is one JSON file under `~/.jaa/sessions/`.
 * The agent loop writes full transcripts here so conversations (and future
 * agent state) survive across invocations and can be resumed or surveyed.
 *
 * Security: ids are validated against a strict pattern before touching the
 * filesystem (they become filenames), and files are validated against a zod
 * schema on read — the boundary treats disk contents as hostile input.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { jaaPaths } from "../config/paths.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";

const ID_PATTERN = /^s-[A-Za-z0-9_-]{4,63}$/;
const TITLE_MAX = 60;
const FILE_PERMS = 0o600;

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  provider?: string;
  model?: string;
  title?: string;
  messages: ChatMessage[];
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  title?: string;
  provider?: string;
  model?: string;
}

export interface NewSessionOptions {
  provider?: string;
  model?: string;
  systemPrompt?: string;
  messages?: ChatMessage[];
}

const toolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z.array(toolCallSchema).optional(),
});

const sessionSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  createdAt: z.string(),
  updatedAt: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  messages: z.array(messageSchema),
});

function sessionsDir(): string {
  return jaaPaths().sessionsDir;
}

function assertSafeId(id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid session id "${id}"`);
  }
}

function sessionFilePath(id: string): string {
  assertSafeId(id);
  return join(sessionsDir(), `${id}.json`);
}

/** Monotonic-ish id: base36 timestamp + random hex. Safe as a filename. */
export function newSessionId(): string {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `s-${stamp}-${rand}`;
}

/** Title from the first user message — one line, hard-truncated. */
export function deriveTitle(messages: ChatMessage[]): string | undefined {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const oneLine = firstUser.content.replace(/\s+/g, " ").trim();
  if (!oneLine) return undefined;
  if (oneLine.length <= TITLE_MAX) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

export function createSession(options: NewSessionOptions = {}): Session {
  const now = new Date().toISOString();
  const messages: ChatMessage[] = [...(options.messages ?? [])];
  // Seed the system prompt only when starting a brand-new conversation.
  if (options.systemPrompt && messages.length === 0) {
    messages.unshift({ role: "system", content: options.systemPrompt });
  }
  const session: Session = { id: newSessionId(), createdAt: now, updatedAt: now, messages };
  if (options.provider) session.provider = options.provider;
  if (options.model) session.model = options.model;
  const title = deriveTitle(messages);
  if (title) session.title = title;
  return session;
}

/** Adds messages, bumps the updatedAt timestamp, keeps the title from the first user message. */
export function appendMessages(session: Session, ...messages: ChatMessage[]): Session {
  session.messages.push(...messages);
  session.updatedAt = new Date().toISOString();
  if (!session.title) {
    const title = deriveTitle(session.messages);
    if (title) session.title = title;
  }
  return session;
}

/**
 * Writes the session atomically (temp file + rename) so a crash never leaves a
 * half-written JSON file, and locks permissions to owner-only on POSIX.
 */
export function saveSession(session: Session): void {
  assertSafeId(session.id);
  const dir = sessionsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${session.id}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: FILE_PERMS });
  if (process.platform !== "win32") chmodSync(tmp, FILE_PERMS);
  renameSync(tmp, file);
}

/** Loads a session; returns undefined when the id is unknown. Throws on corrupt files. */
export function loadSession(id: string): Session | undefined {
  const file = sessionFilePath(id);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new Error(`session "${id}" is corrupt (not valid JSON)`);
  }
  const result = sessionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`session "${id}" is corrupt (schema mismatch: ${result.error.issues[0]?.path.join(".") ?? "unknown"})`);
  }
  return fromParsed(result.data);
}

function fromParsed(parsed: z.infer<typeof sessionSchema>): Session {
  const session: Session = {
    id: parsed.id,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    messages: parsed.messages.map((m) => toChatMessage(m)),
  };
  if (parsed.provider) session.provider = parsed.provider;
  if (parsed.model) session.model = parsed.model;
  if (parsed.title) session.title = parsed.title;
  return session;
}

function toChatMessage(m: z.infer<typeof messageSchema>): ChatMessage {
  const msg: ChatMessage = { role: m.role, content: m.content };
  if (m.toolCallId) msg.toolCallId = m.toolCallId;
  if (m.toolCalls && m.toolCalls.length > 0) msg.toolCalls = m.toolCalls.map((c) => toToolCall(c));
  return msg;
}

function toToolCall(c: z.infer<typeof toolCallSchema>): ToolCall {
  return { id: c.id, name: c.name, arguments: c.arguments };
}

/** All stored sessions, newest-updated first. Corrupt/unknown files are skipped. */
export function listSessions(): SessionMeta[] {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const metas: SessionMeta[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    if (!ID_PATTERN.test(id)) continue;
    let session: Session | undefined;
    try {
      session = loadSession(id);
    } catch {
      continue; // unreadable/corrupt — skip
    }
    if (!session) continue;
    metas.push(toMeta(session));
  }
  if (metas.length > 0) metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return metas;
}

function toMeta(session: Session): SessionMeta {
  const meta: SessionMeta = {
    id: session.id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
  };
  if (session.title) meta.title = session.title;
  if (session.provider) meta.provider = session.provider;
  if (session.model) meta.model = session.model;
  return meta;
}

/** Removes a session file. Returns true when something was deleted. */
export function removeSession(id: string): boolean {
  const file = sessionFilePath(id);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

export { ID_PATTERN, sessionFilePath };