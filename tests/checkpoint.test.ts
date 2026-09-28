import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSession, loadSession, saveSession } from "../src/agent/session.js";
import type { Session } from "../src/agent/session.js";
import { MUTATING_TOOLS } from "../src/permissions/rules.js";
import { defaultToolDefinitions } from "../src/tools/index.js";
import type { ToolContext, ToolDefinition } from "../src/tools/types.js";
import { checkpointDir, cleanupCheckpoints, DEFAULT_MAX_CHECKPOINTS_PER_SESSION, hashFile, listCheckpoints, recordCheckpoint, snapshotPath } from "../src/checkpoint/store.js";
import { cleanupSessionCheckpoints, createCheckpoint, createCheckpointFromTool } from "../src/checkpoint/create.js";
import { restoreFilesToTurn, restoreMessagesToTurn, restoreToTurn } from "../src/checkpoint/restore.js";
import { forkSession } from "../src/checkpoint/fork.js";
import type { CheckpointConfig } from "../src/checkpoint/types.js";

/**
 * Phase 14's gate, in order of how much it can hurt when it is wrong:
 *
 * - A snapshot that escapes the root is a write outside the workspace, so the
 *   traversal cases come first and are tested hardest.
 * - A rewind that lands on the wrong bytes silently corrupts a session, so the
 *   turn semantics are pinned to a concrete multi-turn scenario rather than to
 *   a restatement of the rule.
 * - A fork that aliases its source turns a branch into a shared mutable object.
 */

function need<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label} to be defined`);
  return value;
}

let tmp: string;
let root: string;
let outside: string;
let ctx: ToolContext;
let planted: number;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-ckpt-"));
  root = join(tmp, "workspace");
  outside = join(tmp, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  process.env.JAA_HOME = tmp;
  ctx = { root, cwd: root, allowBash: false };
  planted = 0;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

function tool(name: string): ToolDefinition {
  const found = defaultToolDefinitions().find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool named ${name}`);
  return found;
}

function writeInRoot(relPath: string, content: string): string {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

function read(abs: string): string {
  return readFileSync(abs, "utf8");
}

/** The `<hash>.json` snapshots currently on disk for a session. */
function storedSnapshots(session: Session): string[] {
  return readdirSync(checkpointDir(session))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/** One turn's write: snapshot the file as it stands, then apply the write. */
function commit(session: Session, file: string, turn: number, toolCallId: string, next: string): void {
  recordCheckpoint(session, file, turn, toolCallId);
  writeFileSync(file, next, "utf8");
}

/**
 * Write a snapshot straight into the store.
 *
 * `recordCheckpoint` is only ever reached behind `confinePath`, so an
 * out-of-root path cannot arrive through the public API. The store is on-disk
 * state from an earlier run, though, so this is how a tampered, foreign, or
 * hand-edited snapshot is reproduced for the traversal cases.
 */
function plantSnapshot(session: Session, file: string, turn: number, content: string): string {
  const name = `planted-${planted++}.json`;
  const abs = join(checkpointDir(session), name);
  writeFileSync(abs, `${JSON.stringify({ file, turn, toolCallId: "planted", timestamp: "2026-01-01T00:00:00.000Z", content })}\n`, "utf8");
  return abs;
}

// A file's content on either side of each write in the scenarios below. The
// suffixes are the turn whose write produced the line, so a mismatch names the
// turn that was applied by mistake.
const A0 = "a — before turn 2\n";
const A1 = "a — after turn 2\n";
const A2 = "a — after turn 3\n";
const B0 = "b — before turn 5\n";
const B1 = "b — after turn 5\n";
const C0 = "c — before turn 1\n";
const C1 = "c — after turn 1\n";
const C2 = "c — after turn 2\n";
const C3 = "c — after turn 3\n";

/**
 * A three-turn session over two files: `a.txt` is written on turns 2 and 3,
 * `b.txt` on turn 5. The tree left behind holds A2 and B1.
 */
function playedSession(): { session: Session; a: string; b: string } {
  const session = createSession();
  const a = writeInRoot("a.txt", A0);
  const b = writeInRoot("b.txt", B0);
  commit(session, a, 2, "call-a2", A1);
  commit(session, a, 3, "call-a3", A2);
  commit(session, b, 5, "call-b5", B1);
  return { session, a, b };
}

describe("create/restore round-trip", () => {
  it("puts back the exact bytes the file held when its snapshot was taken", () => {
    // CRLF, a tab, a non-BMP character, and no trailing newline: anything that
    // normalises whitespace or re-encodes the text on the way through fails
    // here rather than passing on a fixture too tame to notice.
    const original = "line one\r\n\tindented \u{1f680} rocket\nno trailing newline";
    const session = createSession();
    const file = writeInRoot("exact.txt", original);

    recordCheckpoint(session, file, 1, "call-1");
    writeFileSync(file, "clobbered by the agent", "utf8");
    expect(read(file)).not.toBe(original);

    const result = restoreFilesToTurn(session, 0, ctx);
    expect(result.errors).toEqual([]);
    expect(result.restored).toHaveLength(1);
    expect(read(file)).toBe(original);
    // The result names the file that was written, not the snapshot that was read.
    expect(need(result.restored[0], "restored[0]").filePath).toBe(file);
    expect(need(result.restored[0], "restored[0]").turn).toBe(1);
  });

  it("rewinds repeatedly, because a restore does not consume the snapshot", () => {
    const session = createSession();
    const file = writeInRoot("repeat.txt", "v0\n");
    recordCheckpoint(session, file, 1, "call-1");
    writeFileSync(file, "v1\n", "utf8");
    recordCheckpoint(session, file, 2, "call-2");
    writeFileSync(file, "v2\n", "utf8");

    expect(read(file)).toBe("v2\n");
    expect(restoreFilesToTurn(session, 1, ctx).errors).toEqual([]);
    expect(read(file)).toBe("v1\n");
    expect(restoreFilesToTurn(session, 0, ctx).errors).toEqual([]);
    expect(read(file)).toBe("v0\n");
    expect(listCheckpoints(session)).toHaveLength(2);
  });

  it("restores files and transcript together through the combined entry point", () => {
    const session = createSession({ messages: [{ role: "user", content: "go" }] });
    const file = writeInRoot("both.txt", "v0\n");
    commit(session, file, 3, "call-3", "v1\n");
    session.messages.push({ role: "assistant", content: "a1" }, { role: "user", content: "a2" });
    saveSession(session);

    // `reportOnly`, not `preserveCurrent`. The local is named `dryRun` because
    // the case under test is the dry run, and the dry run is `reportOnly`:
    // `preserveCurrent` guards the stored transcript only and still writes the
    // working tree, so a `preserveCurrent: true` call here is a real restore
    // wearing a dry run's name.
    const dryRun = restoreToTurn(session, 2, ctx, { reportOnly: true });
    expect(dryRun.success).toBe(true);
    expect(dryRun.errors).toEqual([]);
    // The plan names the file a real rewind would write...
    expect(dryRun.files.restored.map((f) => basename(f.filePath))).toEqual(["both.txt"]);
    // ...and writes nothing, so the file still holds what the agent put there.
    expect(read(file)).toBe("v1\n");
    expect(dryRun.messages.restored.map((m) => m.content)).toEqual(["go", "a1"]);
    expect(dryRun.messages.skipped.map((m) => m.content)).toEqual(["a2"]);
    // A report-only run leaves the stored transcript alone too, so the plan
    // cannot be half-applied.
    expect(need(loadSession(session.id), "stored").messages).toHaveLength(3);

    // The same call with neither option applies the plan: the file goes back and
    // the transcript is cut at the target turn.
    const applied = restoreToTurn(session, 2, ctx);
    expect(applied.success).toBe(true);
    expect(read(file)).toBe("v0\n");
    expect(need(loadSession(session.id), "stored").messages.map((m) => m.content)).toEqual(["go", "a1"]);
  });

  it("reports the whole plan under reportOnly and writes nothing, including a file that is not there", () => {
    // `reportOnly` is the one option that means "report only", and it has to mean
    // it for both halves: the working tree and the stored transcript. The case
    // that proves it is a snapshot naming a file the tree no longer has, because
    // that is the write a report has to withhold — a real restore would create
    // the file from the snapshot.
    const session = createSession();
    const existing = writeInRoot("plan-only.txt", "v0\n");
    commit(session, existing, 2, "call-2", "v1\n");
    const absent = join(root, "never-existed.txt");
    plantSnapshot(session, absent, 3, "resurrected\n");
    expect(existsSync(absent)).toBe(false);

    const report = restoreFilesToTurn(session, 0, ctx, { reportOnly: true });
    // The plan is computed, not guessed: both snapshots were read, validated and
    // confined, and both are named.
    expect(report.errors).toEqual([]);
    expect(report.restored.map((r) => basename(r.filePath)).sort()).toEqual(["never-existed.txt", "plan-only.txt"]);
    expect(need(report.restored.find((r) => basename(r.filePath) === "never-existed.txt"), "absent entry").turn).toBe(3);

    // Nothing was written: not the edited file, not the absent one.
    expect(read(existing)).toBe("v1\n");
    expect(existsSync(absent)).toBe(false);
    // And the store is untouched, so reporting is not consumption: the same
    // question asked twice answers identically.
    expect(storedSnapshots(session)).toHaveLength(2);
    expect(restoreFilesToTurn(session, 0, ctx, { reportOnly: true }).restored).toEqual(report.restored);

    // Applying it is a separate, later decision, and it then does what the
    // report said it would.
    const applied = restoreFilesToTurn(session, 0, ctx);
    expect(applied.errors).toEqual([]);
    expect(read(existing)).toBe("v0\n");
    expect(read(absent)).toBe("resurrected\n");
  });

  it("reports an unreadable snapshot and still restores the readable ones", () => {
    const session = createSession();
    const good = writeInRoot("good.txt", "good v0\n");
    commit(session, good, 1, "call-good", "good v1\n");

    const dir = checkpointDir(session);
    // Parses as JSON and lists as a checkpoint, but names a different file and
    // carries no `content` to write, so it is selected and then refused.
    writeFileSync(
      join(dir, "shallow.json"),
      JSON.stringify({ file: "other.txt", turn: 1, toolCallId: "shallow", timestamp: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );
    // Not JSON at all: skipped by the listing, and skipped again here.
    writeFileSync(join(dir, "garbage.json"), "{ not json", "utf8");

    const result = restoreFilesToTurn(session, 0, ctx);
    expect(result.errors).toHaveLength(1);
    expect(need(result.errors[0], "errors[0]")).toMatch(/not a readable checkpoint/);
    expect(result.restored.map((r) => basename(r.filePath))).toEqual(["good.txt"]);
    expect(read(good)).toBe("good v0\n");
    expect(existsSync(join(root, "other.txt"))).toBe(false);
  });
});

describe("dedup", () => {
  it("stores one snapshot for content it has already stored, named by that content's hash", () => {
    const session = createSession();
    const file = writeInRoot("stable.txt", "unchanged\n");

    recordCheckpoint(session, file, 1, "call-1");
    recordCheckpoint(session, file, 2, "call-2");
    recordCheckpoint(session, file, 3, "call-3");

    const expected = `${hashFile(file)}.json`;
    expect(storedSnapshots(session)).toEqual([expected]);
    expect(snapshotPath(session, file)).toBe(join(checkpointDir(session), expected));
    // The surviving copy is the first one taken, so the earliest state is kept.
    const entry = need(listCheckpoints(session)[0], "entry");
    expect(entry.turn).toBe(1);
    expect(entry.toolCallId).toBe("call-1");
  });

  it("treats identical content at a second path as the same stored snapshot", () => {
    const session = createSession();
    const one = writeInRoot("one.txt", "same bytes\n");
    const two = writeInRoot("sub/two.txt", "same bytes\n");
    expect(one).not.toBe(two);

    recordCheckpoint(session, one, 1, "call-1");
    recordCheckpoint(session, two, 1, "call-2");

    // The store is content-addressed, not path-addressed, so the second file's
    // identical bytes cost nothing.
    expect(storedSnapshots(session)).toHaveLength(1);
    expect(listCheckpoints(session)).toHaveLength(1);
  });

  it("stores a second snapshot once the file's content actually changes", () => {
    const session = createSession();
    const file = writeInRoot("changing.txt", "v0\n");

    commit(session, file, 1, "call-1", "v1\n");
    expect(storedSnapshots(session)).toHaveLength(1);
    commit(session, file, 2, "call-2", "v2\n");
    expect(storedSnapshots(session)).toHaveLength(2);

    // Both states are addressable, and the older one is still the older one.
    const byTurn = new Map(listCheckpoints(session).map((c) => [c.turn, c.path]));
    expect(byTurn.size).toBe(2);
    expect(byTurn.get(1)).not.toBe(byTurn.get(2));
    expect(restoreFilesToTurn(session, 1, ctx).errors).toEqual([]);
    expect(read(file)).toBe("v1\n");
  });
});

describe("traversal refusal", () => {
  it("refuses every escaping path a snapshot can name, and leaves the outside file untouched", () => {
    // Built per test: the paths depend on this test's temp workspace.
    const hostilePaths: { label: string; path: string }[] = [
      { label: "parent segment", path: "../outside/secret.txt" },
      { label: "nested parent segments", path: "sub/../../outside/secret.txt" },
      { label: "absolute path outside the root", path: join(outside, "secret.txt") },
      { label: "absolute path through the root's parent", path: join(root, "..", "outside", "secret.txt") },
      { label: "deep traversal", path: "../../../../../../../../etc/passwd" },
      { label: "path prefixed to look rooted", path: "a/../../outside/secret.txt" },
    ];
    writeFileSync(join(outside, "secret.txt"), "SECRET\n", "utf8");

    for (const hostile of hostilePaths) {
      const session = createSession();
      const snapshot = plantSnapshot(session, hostile.path, 1, "pwned\n");

      const result = restoreFilesToTurn(session, 0, ctx);
      // Selected and then refused: reported as an error, never as a restore,
      // and never as a silent skip either.
      expect(result.restored, hostile.label).toEqual([]);
      expect(result.errors, hostile.label).toHaveLength(1);
      expect(need(result.errors[0], "errors[0]"), hostile.label).toMatch(/escapes the workspace root/);
      expect(result.skipped, hostile.label).toEqual([]);

      // The whole point: the file outside the root is byte-for-byte unchanged,
      // and the refused snapshot is still on disk rather than silently dropped.
      expect(read(join(outside, "secret.txt")), hostile.label).toBe("SECRET\n");
      expect(existsSync(join(outside, "pwned.txt")), hostile.label).toBe(false);
      expect(existsSync(snapshot), hostile.label).toBe(true);
    }
  });

  it("cannot be walked out of the root by a snapshot whose path carries a null byte", () => {
    const session = createSession();
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "SECRET\n", "utf8");
    plantSnapshot(session, `../outside/secret\u0000.txt`, 1, "pwned\n");

    const result = restoreFilesToTurn(session, 0, ctx);
    expect(result.restored).toEqual([]);
    expect(need(result.errors[0], "errors[0]")).toMatch(/null byte/);
    expect(read(victim)).toBe("SECRET\n");
  });

  it("restores nothing outside the root while still restoring the in-root file beside it", () => {
    // The security case and the ordinary case in one call: refusal is decided
    // per snapshot, so a hostile entry cannot abort or poison a valid rewind.
    const session = createSession();
    const inside = writeInRoot("inside.txt", "inside v0\n");
    commit(session, inside, 1, "call-1", "inside v1\n");
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "SECRET\n", "utf8");
    plantSnapshot(session, "../outside/secret.txt", 2, "pwned\n");
    plantSnapshot(session, join(outside, "secret.txt"), 3, "pwned\n");
    plantSnapshot(session, "../outside/created.txt", 4, "created\n");

    const result = restoreFilesToTurn(session, 0, ctx);
    expect(result.restored.map((r) => basename(r.filePath))).toEqual(["inside.txt"]);
    expect(result.errors).toHaveLength(3);
    for (const error of result.errors) expect(error).toMatch(/escapes the workspace root/);
    expect(read(inside)).toBe("inside v0\n");
    expect(read(victim)).toBe("SECRET\n");
    expect(existsSync(join(outside, "created.txt"))).toBe(false);
  });

  it("resolves a relative snapshot path against the root rather than the process cwd", () => {
    // Confinement is a resolution, not a string test: a snapshot written by a
    // version that stored relative paths still lands inside the root.
    const session = createSession();
    plantSnapshot(session, "nested/made.txt", 1, "written\n");

    const result = restoreFilesToTurn(session, 0, ctx);
    expect(result.errors).toEqual([]);
    expect(result.restored.map((r) => r.filePath)).toEqual([join(root, "nested", "made.txt")]);
    expect(read(join(root, "nested", "made.txt"))).toBe("written\n");
  });

  it("never records a snapshot for a tool call that points outside the root", async () => {
    // The other half of the boundary: the tool path must not create the hostile
    // snapshot in the first place.
    const session = createSession();
    const victim = join(outside, "secret.txt");
    writeFileSync(victim, "SECRET\n", "utf8");
    const escaping = [
      { path: "../outside/secret.txt", content: "pwned\n" },
      { path: victim, content: "pwned\n" },
      { path: "sub/../../outside/secret.txt", content: "pwned\n" },
    ];

    for (const args of escaping) {
      expect(() => createCheckpoint(session, tool("write_file"), args, ctx, 1, "call-1"), args.path).not.toThrow();
      await expect(createCheckpointFromTool(session, "write_file", "call-1", 1, ctx, args), args.path).resolves.toBeUndefined();
    }

    expect(listCheckpoints(session)).toEqual([]);
    expect(storedSnapshots(session)).toEqual([]);
    expect(read(victim)).toBe("SECRET\n");
  });

  it("records nothing for a file the tool is about to create", () => {
    // There is no earlier state to return a newly created file to.
    const session = createSession();
    const fresh = join(root, "not-there-yet.txt");
    expect(() => createCheckpoint(session, tool("write_file"), { path: fresh, content: "new\n" }, ctx, 1, "call-1")).not.toThrow();
    expect(listCheckpoints(session)).toEqual([]);
  });
});

describe("fork isolation", () => {
  it("branches into a new session id that shares no mutable state with the source", () => {
    const source = createSession({ provider: "openai", model: "gpt-test" });
    source.messages.push(
      { role: "user", content: "one" },
      { role: "assistant", content: "two", toolCalls: [{ id: "t1", name: "read_file", arguments: "{}" }] },
    );
    saveSession(source);

    const { forkedSession: fork, errors } = forkSession(source, { targetTurn: 2 });
    expect(errors).toEqual([]);
    expect(fork.id).not.toBe(source.id);
    expect(need(loadSession(fork.id), "fork").id).toBe(fork.id);
    expect(fork.messages.map((m) => m.content)).toEqual(["one", "two"]);
    // Carried across, because a branch runs the same way the source did.
    expect(fork.provider).toBe("openai");
    expect(fork.model).toBe("gpt-test");

    // No shared reference at any level: not the array, not a message, not the
    // tool-call array, not a tool call.
    expect(fork.messages).not.toBe(source.messages);
    for (let i = 0; i < source.messages.length; i++) {
      expect(fork.messages[i], `message ${i}`).not.toBe(source.messages[i]);
    }
    const forkCalls = need(need(fork.messages[1], "fork.messages[1]").toolCalls, "fork toolCalls");
    const sourceCalls = need(need(source.messages[1], "source.messages[1]").toolCalls, "source toolCalls");
    expect(forkCalls).not.toBe(sourceCalls);
    expect(need(forkCalls[0], "fork call").id).toBe("t1");
    expect(need(forkCalls[0], "fork call")).not.toBe(need(sourceCalls[0], "source call"));
  });

  it("keeps a mutation to either side off the other, in memory and on disk", () => {
    const source = createSession();
    source.messages.push({ role: "user", content: "one" }, { role: "user", content: "two" });
    saveSession(source);
    const { forkedSession: fork } = forkSession(source);

    fork.messages.push({ role: "user", content: "fork only" });
    fork.messages[0] = { role: "user", content: "rewritten in the fork" };
    expect(source.messages).toEqual([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ]);

    source.messages.push({ role: "user", content: "source only" });
    source.messages[1] = { role: "user", content: "rewritten in the source" };
    saveSession(source);

    expect(fork.messages).toHaveLength(3);
    expect(fork.messages[0]).toEqual({ role: "user", content: "rewritten in the fork" });
    expect(fork.messages).not.toContainEqual({ role: "user", content: "source only" });
    expect(fork.messages).not.toContainEqual({ role: "user", content: "rewritten in the source" });

    // And the two transcripts are two files, not one file written twice:
    // saving the source left the fork's own file exactly as forkSession wrote it.
    expect(need(loadSession(source.id), "source").messages.map((m) => m.content)).toEqual([
      "one",
      "rewritten in the source",
      "source only",
    ]);
    expect(need(loadSession(fork.id), "fork").messages.map((m) => m.content)).toEqual(["one", "two"]);

    // Saving the fork afterwards rewrites only the fork.
    saveSession(fork);
    expect(need(loadSession(fork.id), "fork").messages.map((m) => m.content)).toEqual([
      "rewritten in the fork",
      "two",
      "fork only",
    ]);
    expect(need(loadSession(source.id), "source").messages).toHaveLength(3);
  });

  it("gives the fork its own checkpoint store rather than the source's history", () => {
    const source = createSession();
    const file = writeInRoot("forked.txt", "source v0\n");
    commit(source, file, 1, "call-1", "source v1\n");
    const { forkedSession: fork } = forkSession(source);

    expect(listCheckpoints(source)).toHaveLength(1);
    expect(listCheckpoints(fork)).toEqual([]);
    expect(checkpointDir(fork)).not.toBe(checkpointDir(source));

    // A checkpoint recorded for the source never leaks into the fork's store.
    recordCheckpoint(fork, file, 9, "call-fork");
    expect(listCheckpoints(fork)).toHaveLength(1);
    expect(listCheckpoints(source)).toHaveLength(1);
    expect(checkpointDir(fork)).not.toBe(checkpointDir(source));
  });

  it("keeps only the messages up to the target turn", () => {
    const source = createSession();
    source.messages.push({ role: "user", content: "m1" }, { role: "user", content: "m2" }, { role: "user", content: "m3" });
    saveSession(source);

    const { forkedSession: fork, errors } = forkSession(source, { targetTurn: 2 });
    expect(errors).toEqual([]);
    expect(fork.messages.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(need(loadSession(source.id), "source").messages).toHaveLength(3);

    const bad = forkSession(source, { targetTurn: 99 });
    expect(bad.errors).toHaveLength(1);
    expect(bad.forkedSession.messages).toEqual([]);
  });
});

describe("turn semantics", () => {
  // `a.txt` was written on turns 2 and 3, `b.txt` on turn 5, so the tree holds
  // A2 and B1. A snapshot tagged T precedes the write of turn T, so the snapshot
  // that carries a file back to the end of turn T is the earliest one taken
  // after T.
  const CASES: { target: number; a: string; b: string; restored: string[] }[] = [
    { target: 1, a: A0, b: B0, restored: ["a.txt", "b.txt"] },
    { target: 2, a: A1, b: B0, restored: ["a.txt", "b.txt"] },
    { target: 3, a: A2, b: B0, restored: ["b.txt"] },
    { target: 4, a: A2, b: B0, restored: ["b.txt"] },
    { target: 5, a: A2, b: B1, restored: [] },
  ];

  it("lands each file on the bytes it held at the end of the target turn", () => {
    for (const testCase of CASES) {
      const label = `turn ${testCase.target}`;
      const { session, a, b } = playedSession();
      expect(read(a), label).toBe(A2);
      expect(read(b), label).toBe(B1);

      const result = restoreFilesToTurn(session, testCase.target, ctx);
      expect(result.errors, label).toEqual([]);
      expect(read(a), label).toBe(testCase.a);
      expect(read(b), label).toBe(testCase.b);
      expect(result.restored.map((r) => basename(r.filePath)).sort(), label).toEqual(testCase.restored);
      // The store is not consumed, so a later rewind back further still works.
      expect(listCheckpoints(session), label).toHaveLength(3);
    }
  });

  it("leaves a file that was not written after the target turn alone, later edits and all", () => {
    // `a.txt` was last written on turn 3, so rewinding to turn 3 does not touch
    // it. Someone edited it since; the agent's rewind has no business undoing
    // that, which is exactly what rewriting it from the turn-3 snapshot would do.
    const { session, a, b } = playedSession();
    writeFileSync(a, "operator hand-edit\n", "utf8");

    const result = restoreFilesToTurn(session, 3, ctx);
    expect(result.errors).toEqual([]);
    expect(read(a)).toBe("operator hand-edit\n");
    expect(read(b)).toBe(B0);
    expect(result.restored.map((r) => basename(r.filePath))).toEqual(["b.txt"]);
    // Reported as skipped rather than silently ignored.
    expect(result.skipped.map((s) => basename(s.filePath)).sort()).toEqual(["a.txt", "a.txt"]);
  });

  it("applies a file's earliest post-target snapshot, not its latest and not all of them", () => {
    const session = createSession();
    const c = writeInRoot("c.txt", C0);
    commit(session, c, 1, "call-c1", C1);
    commit(session, c, 2, "call-c2", C2);
    commit(session, c, 3, "call-c3", C3);
    expect(read(c)).toBe(C3);

    const result = restoreFilesToTurn(session, 0, ctx);
    // Three snapshots are eligible for one file and exactly one is applied.
    // Applying all three would replay the file forward to C3; applying the
    // latest would land on C2. Only the earliest is the state as of turn 0.
    expect(result.restored).toHaveLength(1);
    expect(need(result.restored[0], "restored[0]").turn).toBe(1);
    expect(read(c)).toBe(C0);
    expect(result.skipped.map((s) => s.turn).sort()).toEqual([2, 3]);
  });

  it("treats a turn past the end of the session as a rewind that asks for nothing", () => {
    const { session, a, b } = playedSession();
    const result = restoreFilesToTurn(session, 99, ctx);
    expect(result.errors).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(result.skipped).toHaveLength(3);
    expect(read(a)).toBe(A2);
    expect(read(b)).toBe(B1);
  });
});

describe("retention", () => {
  it("keeps the newest N snapshots and deletes only the rest, inside this session's own directory", () => {
    const session = createSession();
    const other = createSession();
    for (let turn = 1; turn <= 5; turn++) {
      const file = writeInRoot(`f${turn}.txt`, `body ${turn}\n`);
      recordCheckpoint(session, file, turn, `call-${turn}`);
      recordCheckpoint(other, file, turn, `call-${turn}`);
    }

    // Strays inside the session's own directory that are not prunable
    // checkpoints: overwriting a snapshot with junk must not become a way to
    // delete the others.
    const dir = checkpointDir(session);
    const notes = join(dir, "notes.txt");
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(notes, "operator notes\n", "utf8");
    writeFileSync(corrupt, "{ not json", "utf8");

    expect(cleanupCheckpoints(session, { maxCheckpointsPerSession: 2 })).toBe(3);
    expect(listCheckpoints(session).map((c) => c.turn)).toEqual([5, 4]);
    expect(existsSync(notes)).toBe(true);
    expect(read(notes)).toBe("operator notes\n");
    expect(existsSync(corrupt)).toBe(true);

    // Another session's snapshots are never candidates, whatever its own count.
    expect(listCheckpoints(other).map((c) => c.turn)).toEqual([5, 4, 3, 2, 1]);
    expect(dirname(dir)).toBe(join(tmp, "checkpoints"));
    expect(existsSync(checkpointDir(other))).toBe(true);
  });

  it("keeps every snapshot when the session is inside the window", () => {
    const session = createSession();
    for (let turn = 1; turn <= 3; turn++) recordCheckpoint(session, writeInRoot(`k${turn}.txt`, `x${turn}\n`), turn, `c${turn}`);
    expect(cleanupCheckpoints(session, { maxCheckpointsPerSession: 3 })).toBe(0);
    expect(listCheckpoints(session)).toHaveLength(3);
  });

  it("treats an absent or nonsensical limit as the default window, not as 'delete everything'", () => {
    const session = createSession();
    for (let turn = 1; turn <= 3; turn++) recordCheckpoint(session, writeInRoot(`g${turn}.txt`, `x${turn}\n`), turn, `c${turn}`);
    const before = readdirSync(checkpointDir(session)).sort();

    const rejected: CheckpointConfig[] = [{}, { maxCheckpointsPerSession: 0 }, { maxCheckpointsPerSession: -5 }, { maxCheckpointsPerSession: 2.5 }];
    for (const options of rejected) {
      expect(cleanupCheckpoints(session, options), JSON.stringify(options)).toBe(0);
    }
    expect(readdirSync(checkpointDir(session)).sort()).toEqual(before);
    expect(listCheckpoints(session)).toHaveLength(3);
  });

  it("runs the default window through the session-end wrapper, and invents no store for a session that wrote nothing", () => {
    // The wrapper is what the CLI calls when a run ends, so it is the one that
    // has to make retention actually happen — through the store's own default
    // window, not a policy of its own.
    const pruned = createSession();
    const untouched = createSession();
    for (let turn = 1; turn <= DEFAULT_MAX_CHECKPOINTS_PER_SESSION + 1; turn++) {
      recordCheckpoint(pruned, writeInRoot(`w${turn}.txt`, `body ${turn}\n`), turn, `call-${turn}`);
    }
    expect(listCheckpoints(pruned)).toHaveLength(DEFAULT_MAX_CHECKPOINTS_PER_SESSION + 1);

    cleanupSessionCheckpoints(pruned);
    expect(listCheckpoints(pruned)).toHaveLength(DEFAULT_MAX_CHECKPOINTS_PER_SESSION);
    // The newest snapshot survives, so the session can still be rewound as far
    // as the window reaches.
    expect(need(listCheckpoints(pruned)[0], "newest").turn).toBe(DEFAULT_MAX_CHECKPOINTS_PER_SESSION + 1);
    // Running it again at a live session's end is a no-op, not a second prune.
    cleanupSessionCheckpoints(pruned);
    expect(listCheckpoints(pruned)).toHaveLength(DEFAULT_MAX_CHECKPOINTS_PER_SESSION);

    // A session that never snapshotted a file has no store on disk, and
    // retention must not be the thing that gives it one: the store reads
    // through a helper that creates the directory it reads. Called blindly at
    // the end of every run, that is one empty directory per run forever.
    expect(existsSync(join(tmp, "checkpoints", untouched.id))).toBe(false);
    cleanupSessionCheckpoints(untouched);
    expect(existsSync(join(tmp, "checkpoints", untouched.id))).toBe(false);
  });
});

describe("mutating-tool gating", () => {
  it("snapshots a mutating tool call exactly once and never a read-only one", () => {
    const session = createSession();
    const file = writeInRoot("gated.txt", "before\n");

    createCheckpoint(session, tool("read_file"), { path: file }, ctx, 1, "call-read");
    expect(listCheckpoints(session)).toEqual([]);

    createCheckpoint(session, tool("write_file"), { path: file, content: "after\n" }, ctx, 1, "call-write");
    expect(listCheckpoints(session).map((c) => [c.file, c.turn, c.toolCallId])).toEqual([[file, 1, "call-write"]]);
    // The path stored is the confined absolute one, not the model's string.
    expect(need(listCheckpoints(session)[0], "entry").file).toBe(file);

    // A second mutating call sees the same bytes the first one snapshotted, so
    // dedup holds it at one snapshot rather than one per call.
    createCheckpoint(session, tool("write_file"), { path: file, content: "after\n" }, ctx, 2, "call-write-2");
    expect(storedSnapshots(session)).toHaveLength(1);
    expect(listCheckpoints(session)).toHaveLength(1);
  });

  it("covers every tool the permission engine calls mutating, and only the ones that name a file", () => {
    // `MUTATING_TOOLS` is the single source of truth, so the gate is pinned
    // against it rather than against a hand-written list that could drift.
    const session = createSession();
    const names = defaultToolDefinitions().map((t) => t.name);
    for (const name of MUTATING_TOOLS) expect(names, name).toContain(name);

    // Each tool is called the way its own schema accepts, so the tool — not the
    // argument shape — decides whether there is a single file to snapshot.
    const argsFor: Record<string, (file: string) => unknown> = {
      write_file: (file) => ({ path: file, content: "x" }),
      patch: (file) => ({ path: file, hunks: [{ oldText: "a", newText: "b" }] }),
      bash: () => ({ command: "echo hi" }),
      git_diff: () => ({ staged: true }),
    };

    for (const name of MUTATING_TOOLS) {
      const build = need(argsFor[name], `args for ${name}`);
      // A distinct file per tool, so each snapshot has distinct content and
      // content-addressing cannot collapse two of them into one.
      const file = writeInRoot(`gate-${name}.txt`, `body for ${name}\n`);
      createCheckpoint(session, tool(name), build(file), ctx, 1, `call-${name}`);
    }

    // `bash` and `git_diff` are mutating but name no single file, so nothing is
    // stored for them. Every other mutating tool is covered.
    expect(listCheckpoints(session).map((c) => c.toolCallId).sort()).toEqual(["call-patch", "call-write_file"]);
  });

  it("snapshots a patch call through the tool's own schema", () => {
    const session = createSession();
    const file = writeInRoot("patched.txt", "alpha\n");

    createCheckpoint(session, tool("patch"), { path: file, hunks: [{ oldText: "alpha", newText: "beta" }] }, ctx, 3, "call-patch");
    const entry = need(listCheckpoints(session)[0], "entry");
    expect([entry.file, entry.turn, entry.toolCallId]).toEqual([file, 3, "call-patch"]);

    writeFileSync(file, "beta\n", "utf8");
    expect(restoreFilesToTurn(session, 0, ctx).errors).toEqual([]);
    expect(read(file)).toBe("alpha\n");
  });

  it("no-ops cleanly for a mutating tool whose arguments do not validate", () => {
    const session = createSession();
    const file = writeInRoot("invalid.txt", "body\n");
    for (const args of [{}, { path: 42 }, { path: file, hunks: [] }]) {
      expect(() => createCheckpoint(session, tool("patch"), args, ctx, 1, "call-1"), JSON.stringify(args)).not.toThrow();
    }
    expect(listCheckpoints(session)).toEqual([]);
  });
});

describe("tools with no single file target", () => {
  /**
   * Every way `bash` and `git_diff` can be called, including a `path` smuggled
   * into arguments the tool does not declare.
   */
  const CALLS: { name: string; args: unknown }[] = [
    { name: "bash", args: { command: "rm -rf /" } },
    { name: "bash", args: { command: "echo hi", timeoutMs: 1000 } },
    { name: "bash", args: { command: "echo hi", path: "untouched.txt" } },
    { name: "git_diff", args: {} },
    { name: "git_diff", args: { staged: true } },
    { name: "git_diff", args: { staged: true, path: "untouched.txt" } },
  ];

  it("no-ops instead of throwing when the tool's own schema is consulted", () => {
    const session = createSession();
    const file = writeInRoot("untouched.txt", "body\n");

    for (const call of CALLS) {
      const label = `${call.name} ${JSON.stringify(call.args)}`;
      // Neither call throws, and neither stores anything. A `path` the tool
      // does not declare is stripped by its schema, so even a smuggled one
      // names no target and there is nothing to snapshot.
      expect(() => createCheckpoint(session, tool(call.name), call.args, ctx, 1, "call-x"), label).not.toThrow();
      expect(listCheckpoints(session), label).toEqual([]);
    }

    expect(storedSnapshots(session)).toEqual([]);
    expect(read(file)).toBe("body\n");
  });

  it("no-ops instead of throwing when only the tool name and raw arguments are known", async () => {
    const session = createSession();
    const file = writeInRoot("untouched.txt", "body\n");

    // The raw-argument entry point has no schema to strip against, so it is
    // exercised with the calls these two tools actually receive.
    const raw: { name: string; args: unknown }[] = [
      { name: "bash", args: { command: "rm -rf /" } },
      { name: "bash", args: { command: "echo hi", timeoutMs: 1000 } },
      { name: "git_diff", args: {} },
      { name: "git_diff", args: { staged: true } },
    ];
    for (const call of raw) {
      await expect(
        createCheckpointFromTool(session, call.name, "call-x", 1, ctx, call.args),
        `${call.name} ${JSON.stringify(call.args)}`,
      ).resolves.toBeUndefined();
    }

    expect(listCheckpoints(session)).toEqual([]);
    expect(storedSnapshots(session)).toEqual([]);
    expect(read(file)).toBe("body\n");
  });

  it("keeps bash side effects out of scope rather than half-snapshotting them", () => {
    // Bash can touch anything, so there is no single file to record. The spec
    // puts this out of scope explicitly, and the store reflects that: a
    // checkpoint is never taken for a shell call that names no path.
    const session = createSession();
    const created = join(root, "made-by-bash.txt");
    createCheckpoint(session, tool("bash"), { command: "touch made-by-bash.txt" }, ctx, 1, "call-bash");
    expect(existsSync(created)).toBe(false);
    expect(listCheckpoints(session)).toEqual([]);
  });
});

describe("conversation restore", () => {
  it("rewinds the transcript to the target turn and can report without destroying it", () => {
    const session = createSession();
    for (let i = 1; i <= 4; i++) session.messages.push({ role: i % 2 === 0 ? "assistant" : "user", content: `m${i}` });
    saveSession(session);

    const dryRun = restoreMessagesToTurn(session, 2, { preserveCurrent: true });
    expect(dryRun.errors).toEqual([]);
    expect(dryRun.restored.map((m) => m.content)).toEqual(["m1", "m2"]);
    expect(dryRun.skipped.map((m) => m.content)).toEqual(["m3", "m4"]);
    expect(need(loadSession(session.id), "stored").messages).toHaveLength(4);

    const applied = restoreMessagesToTurn(session, 2);
    expect(applied.errors).toEqual([]);
    expect(need(loadSession(session.id), "stored").messages.map((m) => m.content)).toEqual(["m1", "m2"]);

    const outOfRange = restoreMessagesToTurn(session, 99);
    expect(outOfRange.errors).toHaveLength(1);
    expect(need(loadSession(session.id), "stored").messages).toHaveLength(2);
  });

  it("reports an unknown session instead of throwing", () => {
    const orphan = createSession();
    const result = restoreMessagesToTurn(orphan, 1);
    expect(result.errors).toHaveLength(1);
    expect(need(result.errors[0], "errors[0]")).toContain(orphan.id);
  });
});
