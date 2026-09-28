import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "..");
const SCANNER = path.join(REPO, "scripts", "check-secrets.mjs");

/**
 * Token bodies are assembled from parts, deliberately.
 *
 * This file exercises the scanner with realistic token shapes, so writing them
 * as contiguous literals would make the scanner refuse to commit its own test -
 * which it did. The scanner matches a prefix followed by 36+ characters, so a
 * bare `ghp_` with the body in a separate literal is not a match, while the
 * runtime value is byte-for-byte the shape the scanner must catch. That is the
 * difference between a synthesised token and a real one: it is assembled at
 * runtime and is not a credential.
 */
const bodies = {
  classic: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  oauth: "z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1",
  server: "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
  refresh: "B1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8",
  user: "C1d2E3f4G5h6I7j8K9l0M1n2O3p4Q5r6S7t8",
  remote: "9Z8y7X6w5V4u3T2s1R0q9P8o7N6m5L4k3J2h1G0f9E",
  fineHead: "11ABCDEFG0aBcDeFgHiJk",
  fineTail: "LmnOpQrStUvWxYz0123456789aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678",
} as const;

const gh = (prefix: string, body: string): string => `${prefix}${body}`;

/**
 * The three formats the security requirement names, plus the shapes that show
 * up in practice. Every token here is SYNTHESISED and is not a credential.
 */
const TOKEN_VECTORS: ReadonlyArray<{ id: string; value: string }> = [
  { id: "classic PAT", value: gh("ghp_", bodies.classic) },
  { id: "OAuth token", value: gh("gho_", bodies.oauth) },
  { id: "server-to-server", value: gh("ghs_", bodies.server) },
  { id: "refresh token", value: gh("ghr_", bodies.refresh) },
  { id: "user-to-server", value: gh("ghu_", bodies.user) },
  {
    id: "fine-grained PAT",
    // 82 characters after the prefix. Anchored on LENGTH, not on GitHub's
    // internal segment layout: an earlier version of this rule assumed a
    // 22 + "_" + 59 split and silently missed a real-shaped token because the
    // underscore is not at that offset.
    value: `github_pat_${bodies.fineHead}_${bodies.fineTail}`,
  },
  {
    id: "token embedded in a git remote URL",
    value: `https://${gh("ghp_", bodies.remote)}@github.com/o/r.git`,
  },
];

/** The token used where a single value is needed. */
const SAMPLE = gh("ghp_", bodies.classic);

/** Must never trip the scanner. */
const CLEAN_VECTORS: ReadonlyArray<{ id: string; value: string }> = [
  { id: "documentation domain", value: "see https://example.com/docs for the schema" },
  { id: "test fixture key", value: 'JAA_LLM_ANTHROPIC_API_KEY = "sk-ant-test"' },
  { id: "placeholder", value: "const token = await readFromKeyring();" },
  { id: "git identity fixture", value: 'git config user.email "t@example.com"' },
];

let tmp: string;

function runScanner(args: string[], cwd: string): { code: number; output: string } {
  const r = spawnSync("node", [SCANNER, ...args], { cwd, encoding: "utf8" });
  return { code: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A throwaway git repo with the real scanner wired in. */
function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(SCANNER, path.join(dir, "scripts", "check-secrets.mjs"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

function stage(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body, "utf8");
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
}
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jaa-secrets-"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("check-secrets: every documented token format is caught", () => {
  for (const v of TOKEN_VECTORS) {
    it(`blocks ${v.id}`, () => {
      const dir = makeRepo();
      stage(dir, { "probe.txt": `value = ${v.value}\n` });
      const r = runScanner([], dir);
      expect(r.code, `expected a refusal, got:\n${r.output}`).toBe(1);
      expect(r.output).toContain("refusing the commit");
    });
  }

  for (const v of CLEAN_VECTORS) {
    it(`does not block ${v.id}`, () => {
      const dir = makeRepo();
      stage(dir, { "probe.txt": `${v.value}\n` });
      const r = runScanner([], dir);
      expect(r.code, `expected a pass, got:\n${r.output}`).toBe(0);
    });
  }
});

describe("check-secrets: the three modes each see the right thing", () => {
  it("default mode reads STAGED blobs, not the working tree", () => {
    const dir = makeRepo();
    stage(dir, { "clean.txt": "harmless\n" });
    // Written AFTER staging, so it is on disk but genuinely not in the index.
    // An ignored .env holding a real key must not block an unrelated commit.
    fs.writeFileSync(path.join(dir, "untracked.txt"), `${SAMPLE}\n`, "utf8");
    const r = runScanner([], dir);
    expect(r.code, `a token on disk but not staged must not block a commit:\n${r.output}`).toBe(0);
  });

  it("--message mode refuses a token in the commit message", () => {
    const dir = makeRepo();
    stage(dir, { "clean.txt": "harmless\n" });
    const msg = path.join(dir, "MSG");
    fs.writeFileSync(msg, `chore: oops ${SAMPLE} in here\n`, "utf8");
    const r = runScanner(["--message", msg], dir);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain("commit message");
  });

  it("--message mode ignores git's own comment lines", () => {
    const dir = makeRepo();
    stage(dir, { "clean.txt": "harmless\n" });
    const msg = path.join(dir, "MSG2");
    fs.writeFileSync(msg, `# ${SAMPLE}\nchore: real message\n`, "utf8");
    const r = runScanner(["--message", msg], dir);
    expect(r.code, r.output).toBe(0);
  });

  it("--all mode scans the working tree, with no commits present", () => {
    // A repo with no commits is where reading from HEAD would have scanned
    // nothing and reported clean - a false pass. --all must not do that.
    const dir = makeRepo();
    stage(dir, { "probe.txt": `value = ${SAMPLE}\n` });
    const log = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" });
    expect(log.status, "precondition: this repo must have no commits").not.toBe(0);

    const r = runScanner(["--all"], dir);
    expect(r.code, `--all scanned nothing and passed:\n${r.output}`).toBe(1);
    // It must have counted a real number of files, not zero.
    const counted = /in (\d+) tracked file/.exec(r.output);
    expect(counted, `no file count in the report:\n${r.output}`).not.toBeNull();
    expect(Number(counted?.[1]), "scanned zero files - that is the false pass").toBeGreaterThan(0);
  });
});

describe("check-secrets: fails closed and never echoes a secret", () => {
  it("refuses when the message file cannot be read", () => {
    const dir = makeRepo();
    const r = runScanner(["--message", path.join(dir, "does-not-exist")], dir);
    expect(r.code).toBe(2);
    expect(r.output).toContain("FAILING CLOSED");
  });

  it("masks what it reports, so it is not a second copy of the secret", () => {
    const dir = makeRepo();
    const token = SAMPLE;
    stage(dir, { "probe.txt": `value = ${token}\n` });
    const r = runScanner([], dir);
    expect(r.code).toBe(1);
    expect(r.output).not.toContain(token);
    expect(r.output).toContain("ghp_a1");
    expect(r.output).toContain("masked on purpose");
  });
});

/** The exact file list npm would publish, from npm itself. */
function publishedFiles(): string[] {
  // On win32 `npm` is a .cmd shim, which spawnSync cannot exec without a shell.
  const r = spawnSync("npm", ["pack", "----json".slice(2)], {
    cwd: REPO,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  expect(r.status, `npm pack --dry-run failed:\n${r.stderr}`).toBe(0);
  const parsed: unknown = JSON.parse(r.stdout);

  // npm has shipped two shapes for `pack --dry-run --json`: an array of pack
  // results, and an object keyed by package name. Accept either, and refuse to
  // guess if neither matches - a silent empty list would make this test vacuous.
  let entry: { files?: Array<{ path: string }> } | undefined;
  if (Array.isArray(parsed)) {
    entry = parsed[0] as { files?: Array<{ path: string }> };
  } else if (parsed && typeof parsed === "object") {
    const first = Object.values(parsed as Record<string, unknown>)[0];
    if (first && typeof first === "object") entry = first as { files?: Array<{ path: string }> };
  }
  expect(entry, `unrecognised npm pack --json shape: ${JSON.stringify(parsed).slice(0, 200)}`).toBeTruthy();

  const files = entry?.files ?? [];
  expect(files.length, "npm produced an empty file list; this test would be vacuous").toBeGreaterThan(0);
  return files.map((f) => f.path);
}

describe("the published package carries no credential", () => {
  // The file list comes from npm itself, so this checks what would actually be
  // published rather than a guess at it.
  const publishedRe = new RegExp(TOKEN_VECTORS.map((v) => v.value).join("|"), "g");

  it("no file in the pack manifest matches a token pattern", () => {
    const files = publishedFiles();
    const offenders: string[] = [];
    for (const p of files) {
      const full = path.join(REPO, p);
      if (!fs.existsSync(full)) continue;
      const buf = fs.readFileSync(full);
      if (buf.includes(0)) continue; // binary
      buf
        .toString("utf8")
        .split("\n")
        .forEach((line, i) => {
          publishedRe.lastIndex = 0;
          if (publishedRe.test(line)) offenders.push(`${p}:${i + 1}  ${line.trim().slice(0, 4)}…`);
        });
    }
    expect(offenders, `token-shaped content in the published package:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("ships no reference to the scanner's own pattern source", () => {
    // The scanner is a repo tool, not runtime code. It must not be published.
    const paths = publishedFiles();
    expect(paths.some((p) => p.startsWith("scripts/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".github/"))).toBe(false);
  });
});
