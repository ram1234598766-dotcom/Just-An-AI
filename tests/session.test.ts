import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvLayers } from "../src/config/env.js";
import {
  ID_PATTERN,
  appendMessages,
  createSession,
  deriveTitle,
  loadSession,
  listSessions,
  removeSession,
  saveSession,
  sessionFilePath,
} from "../src/agent/session.js";

function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-sess-"));
  process.env.JAA_HOME = tmp;
  resetEnvLayers();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  resetEnvLayers();
  rmSync(tmp, { recursive: true, force: true });
});

describe("session ids", () => {
  it("generates ids that match the safe pattern", () => {
    for (let i = 0; i < 50; i++) {
      const id = createSession().id;
      expect(ID_PATTERN.test(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(40);
    }
  });

  it("collisions are astronomically unlikely (timestamp + random hex)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = createSession().id;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});

describe("createSession / appendMessages", () => {
  it("seeds the system prompt only for a brand-new conversation", () => {
    const fresh = createSession({ provider: "ollama", model: "llama3", systemPrompt: "be brief" });
    expect(fresh.messages).toEqual([{ role: "system", content: "be brief" }]);
    expect(fresh.provider).toBe("ollama");
    expect(fresh.model).toBe("llama3");

    const withHistory = createSession({ systemPrompt: "ignored", messages: [{ role: "user", content: "hi" }] });
    expect(withHistory.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("derives a one-line title from the first user message", () => {
    const s = createSession({ systemPrompt: "sys", messages: [{ role: "user", content: "  how\n do   I lint?  " }] });
    expect(s.title).toBe("how do I lint?");
  });

  it("hard-truncates long titles with an ellipsis", () => {
    const long = "x".repeat(120);
    const title = need(deriveTitle([{ role: "user", content: long }]), "title");
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("leaves messages without a user absent a title", () => {
    expect(createSession().title).toBeUndefined();
    expect(createSession({ systemPrompt: "sys" }).title).toBeUndefined();
  });

  it("appends messages and bumps updatedAt", () => {
    const s = createSession();
    const before = s.updatedAt;
    appendMessages(s, { role: "user", content: "hello" });
    expect(s.messages).toHaveLength(1);
    expect(s.updatedAt >= before).toBe(true);
    expect(need(s.title, "title")).toBe("hello");
  });
});

describe("save / load round-trip", () => {
  it("persists and restores a session exactly (tool calls included)", () => {
    const s = createSession({
      provider: "ollama",
      model: "llama3",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "list" },
      ],
    });
    appendMessages(
      s,
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ls", arguments: "{}" }] },
      { role: "tool", content: "src", toolCallId: "c1" },
    );
    saveSession(s);

    const loaded = need(loadSession(s.id), "loaded session");
    expect(loaded).toEqual(s);
  });

  it("returns undefined for an unknown id", () => {
    expect(loadSession("s-unknown-0000")).toBeUndefined();
  });

  it("rejects ids that could be path traversal", () => {
    const bad = ["s-../../../etc/passwd", "s-a", "../x", "s-0".repeat(70)];
    for (const id of bad) {
      expect(() => sessionFilePath(id)).toThrow();
    }
  });

  it("loadSession throws on corrupt JSON", () => {
    const s = createSession();
    saveSession(s);
    writeFileSync(sessionFilePath(s.id), "{ not json", "utf8");
    expect(() => loadSession(s.id)).toThrow(/corrupt/);
  });

  it("loadSession throws when the schema is violated", () => {
    const s = createSession();
    saveSession(s);
    writeFileSync(sessionFilePath(s.id), `{"id":"${s.id}"}`, "utf8");
    expect(() => loadSession(s.id)).toThrow(/corrupt/);
  });

  it("removeSession returns false when missing, true when deleted", () => {
    const s = createSession();
    expect(removeSession(s.id)).toBe(false);
    saveSession(s);
    expect(removeSession(s.id)).toBe(true);
    expect(existsSync(sessionFilePath(s.id))).toBe(false);
  });
});

describe("listSessions", () => {
  it("returns empty when the dir does not exist", () => {
    expect(listSessions()).toEqual([]);
  });

  it("lists sessions newest-updated first with metadata", async () => {
    const a = createSession({ provider: "ollama", model: "qwen", systemPrompt: "sys" });
    saveSession(a);
    await new Promise((r) => setTimeout(r, 5));
    const b = createSession({ provider: "gemini", model: "flash", systemPrompt: "sys" });
    appendMessages(b, { role: "user", content: "second" });
    saveSession(b);

    const metas = listSessions();
    expect(metas.map((m) => m.id)).toEqual([b.id, a.id]);
    const first = need(metas[0], "first meta");
    expect(first).toMatchObject({ provider: "gemini", model: "flash", title: "second", messageCount: 2 });
  });

  it("skips corrupt files instead of crashing", () => {
    const s = createSession();
    saveSession(s);
    mkdirSync(join(tmp, "sessions"), { recursive: true });
    writeFileSync(join(tmp, "sessions", "s-corrupt-0001.json"), "not json", "utf8");
    expect(listSessions()).toHaveLength(1);
  });
});