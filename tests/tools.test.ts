import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/tools/index.js";
import { canonicalPath, confinePath } from "../src/tools/registry.js";
import { globToRegExp } from "../src/tools/fs.js";
import type { ToolContext } from "../src/tools/index.js";

let tmp: string;
let ctx: ToolContext;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-tools-"));
  ctx = { root: tmp, cwd: tmp, allowBash: false };
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const registry = createDefaultRegistry();

/**
 * A second name for an existing directory, so the lexical and the canonical
 * answers to "is this inside the root" disagree.
 *
 * On Windows that second name is the 8.3 short alias; on POSIX it is a symlink.
 * A junction is used rather than a directory symlink because Windows will not
 * create the latter without elevation, while a junction needs none.
 */
function aliasOf(dir: string, name: string): string {
  const link = join(tmp, name);
  symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
  return link;
}

/**
 * Whether this host hands out a short (8.3) spelling of its temp directory, as
 * Windows does for any name longer than 8.3 characters. That is a property of
 * the machine, not of the code, so the 8.3-specific assertions run only where
 * such a pair exists rather than pretending one can be invented anywhere.
 */
const HOST_SHORT_FORM = realpathSync.native(tmpdir()) !== tmpdir();

/**
 * Create a directory link at `link` pointing at `target`, and say whether it is
 * usable as one. A junction rather than a directory symlink on Windows, because
 * creating the latter needs elevation while a junction needs none.
 *
 * Usability is checked rather than assumed: the link has to resolve to the
 * target, or the assertion it supports would be testing a plain directory.
 */
function linkDir(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  } catch {
    return false;
  }
  const same = (a: string, b: string): boolean =>
    process.platform === "linux" ? a === b : a.toLowerCase() === b.toLowerCase();
  return same(realpathSync.native(link), realpathSync.native(target));
}

/**
 * Whether this host will create a directory link that the filesystem resolves
 * as one. Some hosts refuse (a locked-down Windows policy, a filesystem without
 * link support); those runs skip the link assertions rather than passing them
 * vacuously.
 */
const HOST_LINKS = ((): boolean => {
  const dir = mkdtempSync(join(tmpdir(), "jaa-linkprobe-"));
  try {
    return linkDir(dir, join(dir, "probe"));
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

describe("confinePath: two spellings of one path", () => {
  it("admits a path that only escapes because the root is spelled differently", () => {
    const root = join(tmp, "workspace");
    mkdirSync(root, { recursive: true });
    const alias = aliasOf(root, "wsalias");
    const confined: ToolContext = { root, cwd: root, allowBash: false };

    // Lexically the alias is a sibling of the root, so a purely textual
    // comparison refuses a file that is genuinely inside the workspace.
    expect(alias).not.toBe(root);
    expect(confinePath(confined, join(alias, "f.txt"))).toBe(join(alias, "f.txt"));
  });

  it("refuses every escape once canonicalisation is in play", () => {
    // The fallback exists to admit a second spelling of the root, so the
    // security property to pin is that it can only ever admit that: anything
    // still escaping afterwards is refused, and `..` is collapsed lexically
    // before the filesystem is consulted at all, so neither an alias nor a
    // symlink can be used to climb out.
    const root = join(tmp, "workspace");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const alias = aliasOf(root, "wsalias");
    const confined: ToolContext = { root, cwd: root, allowBash: false };

    const hostile = [
      { label: "climb out through the alias", p: join(alias, "..", "outside", "secret.txt") },
      { label: "alias then all the way up", p: join(alias, "..", "..", "..", "..", "..", "..", "etc", "passwd") },
      { label: "absolute path beside the root", p: join(outside, "secret.txt") },
      { label: "relative parent segment", p: "../outside/secret.txt" },
      { label: "deep traversal", p: "../../../../../../../../etc/passwd" },
      { label: "parent directory itself", p: join(alias, "..") },
    ];
    for (const { label, p } of hostile) {
      expect(() => confinePath(confined, p), label).toThrow(/escapes the workspace root/);
    }

    // `..` that lands back inside is still fine: the alias makes no difference
    // to how a path is resolved, only to how the two results are compared.
    expect(confinePath(confined, join(alias, "..", "workspace", "ok.txt"))).toBe(join(root, "ok.txt"));
  });

  it("leaves the normalised form of a path stable, and never the caller's own spelling", () => {
    // The normal form is what the two spellings are compared as, so it has to
    // be a fixed point; and the value handed back to callers stays theirs, so
    // nothing downstream sees a path it did not pass in.
    const once = canonicalPath(tmp);
    expect(canonicalPath(once)).toBe(once);

    const root = join(tmp, "workspace");
    mkdirSync(root, { recursive: true });
    const alias = aliasOf(root, "wsalias");
    const confined: ToolContext = { root, cwd: root, allowBash: false };
    const mine = join(alias, "f.txt");
    expect(confinePath(confined, mine)).toBe(mine);
    expect(canonicalPath(mine)).toBe(join(realpathSync.native(root), "f.txt"));
  });

  it.skipIf(!HOST_SHORT_FORM)("admits a real Windows 8.3 short path against a long root", () => {
    // The reported failure, with a genuine short path rather than a stand-in:
    // `process.cwd()` and a snapshot recorded by an earlier run can disagree
    // about how to spell one directory, and the short form then looks like an
    // unrelated tree two levels up.
    const longRoot = realpathSync.native(tmp);
    const shortRoot = tmp;
    expect(shortRoot, "this host must expose a short/long pair").not.toBe(longRoot);

    mkdirSync(join(longRoot, "src"), { recursive: true });
    const shortArg = join(shortRoot, "src", "registry.ts");
    const confined: ToolContext = { root: longRoot, cwd: longRoot, allowBash: false };

    expect(canonicalPath(shortArg)).toBe(join(longRoot, "src", "registry.ts"));
    expect(confinePath(confined, shortArg)).toBe(shortArg);
    // And the other way round: a long argument is no more of an escape than a
    // short one.
    const longArg = join(longRoot, "src", "registry.ts");
    const shortCtx: ToolContext = { root: shortRoot, cwd: shortRoot, allowBash: false };
    expect(confinePath(shortCtx, longArg)).toBe(longArg);
  });

  it.skipIf(!HOST_SHORT_FORM)("still refuses a short path that genuinely leaves the root", () => {
    // The 8.3 fix must not become a licence: a short spelling of a directory
    // that is genuinely outside the workspace stays refused.
    const shortWorkspace = join(tmp, "workspace");
    mkdirSync(shortWorkspace, { recursive: true });
    const root = realpathSync.native(shortWorkspace);
    const confined: ToolContext = { root, cwd: root, allowBash: false };
    const shortElsewhere = join(tmpdir(), "definitely-not-the-workspace", "secret.txt");
    expect(canonicalPath(shortElsewhere)).not.toContain(join(root, "definitely-not-the-workspace"));
    expect(() => confinePath(confined, shortElsewhere)).toThrow(/escapes the workspace root/);
  });
});

describe("confinePath: a link planted inside the root", () => {
  /**
   * A workspace with a sibling directory outside it, for the link to straddle.
   * Returns the pieces so each test reads as "root, an outside dir, a link".
   */
  function planted(): { root: string; outside: string; confined: ToolContext } {
    const root = join(tmp, "workspace");
    const outside = join(tmp, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    return { root, outside, confined: { root, cwd: root, allowBash: false } };
  }

  it.skipIf(!HOST_LINKS)("refuses a path that is lexically in-root but points out through a link", () => {
    // The bug this pins: `link/evil.txt` is textually inside the workspace, so a
    // lexical check admits it and hands `fs` a write that lands in `outside`.
    // Containment has to be decided on where the path points, not on how it is
    // spelled, or a link planted inside the root is a write primitive out of it.
    const { root, outside, confined } = planted();
    expect(linkDir(outside, join(root, "link"))).toBe(true);

    const victim = join(root, "link", "evil.txt");
    expect(victim.startsWith(root), "the path must be lexically in-root, or this tests nothing").toBe(true);
    expect(() => confinePath(confined, victim)).toThrow(/escapes the workspace root/);
  });

  it.skipIf(!HOST_LINKS)("refuses a not-yet-created file reached through a link", () => {
    // A write names a file that does not exist yet, so resolution has to walk to
    // the deepest existing ancestor — the link — and re-append the missing tail
    // onto wherever the link leads. `new/deep.txt` must land in `outside`, and
    // the request for it must be refused.
    const { root, outside, confined } = planted();
    expect(linkDir(outside, join(root, "link"))).toBe(true);

    expect(() => confinePath(confined, join(root, "link", "new", "deep.txt"))).toThrow(
      /escapes the workspace root/,
    );
    expect(existsSync(join(outside, "new"))).toBe(false);
  });

  it.skipIf(!HOST_LINKS)("refuses the write itself, and nothing lands outside the root", async () => {
    // End to end, because a refusal that only `confinePath` honours would be
    // worth nothing: the point is that no file appears in the target directory.
    const { root, outside, confined } = planted();
    expect(linkDir(outside, join(root, "link"))).toBe(true);

    const out = await registry.execute(
      "write_file",
      JSON.stringify({ path: join(root, "link", "evil.txt"), content: "owned" }),
      confined,
    );
    expect(out).toContain("escapes the workspace root");
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
  });

  it.skipIf(!HOST_LINKS)("refuses a link one level deeper in the path", () => {
    // The link is not at the top of the path it escapes through: resolution has
    // to keep walking past the in-root components rather than checking the head.
    const { root, outside, confined } = planted();
    mkdirSync(join(root, "src"), { recursive: true });
    expect(linkDir(outside, join(root, "src", "link"))).toBe(true);

    expect(() => confinePath(confined, join(root, "src", "link", "evil.txt"))).toThrow(
      /escapes the workspace root/,
    );
  });

  it.skipIf(!HOST_LINKS)("still admits a link that points at another place inside the root", () => {
    // The fix must refuse links, not links-to-outside: a workspace that links
    // its own directories together is ordinary, and resolving cannot tell the
    // two apart from the path text — only from where the link lands.
    const { root, confined } = planted();
    mkdirSync(join(root, "packages"), { recursive: true });
    expect(linkDir(join(root, "packages"), join(root, "link"))).toBe(true);

    const target = join(root, "link", "app.ts");
    expect(confinePath(confined, target)).toBe(target);
  });

  it.skipIf(!HOST_LINKS)("writes through a link back into the root", async () => {
    const { root, confined } = planted();
    mkdirSync(join(root, "packages"), { recursive: true });
    expect(linkDir(join(root, "packages"), join(root, "link"))).toBe(true);

    const out = await registry.execute(
      "write_file",
      JSON.stringify({ path: join(root, "link", "app.ts"), content: "x" }),
      confined,
    );
    expect(out).not.toContain("escapes the workspace root");
    expect(existsSync(join(root, "packages", "app.ts"))).toBe(true);
  });

  it("admits an ordinary in-root path", () => {
    const { root, confined } = planted();
    const ordinary = join(root, "src", "index.ts");
    expect(confinePath(confined, ordinary)).toBe(ordinary);
    expect(confinePath(confined, "src/index.ts")).toBe(ordinary);
  });

  it("still refuses traversal out of the root", () => {
    // `..` is collapsed before the filesystem is consulted, so no link and no
    // spelling can be used to climb out with it.
    const { outside, confined } = planted();
    for (const p of [
      join(outside, "secret.txt"),
      "../outside/secret.txt",
      join("..", "outside", "secret.txt"),
      join(confined.root, "..", "outside", "secret.txt"),
      "../../../../../../../../etc/passwd",
    ]) {
      expect(() => confinePath(confined, p), p).toThrow(/escapes the workspace root/);
    }
  });
});

describe("tool registry", () => {
  it("advertises every registered tool as a provider-neutral ToolDef", () => {
    const defs = registry.list();
    expect(defs.length).toBeGreaterThan(0);
    for (const def of defs) {
      expect(def.name).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("returns a readable error for an unknown tool", async () => {
    const out = await registry.execute("nope", "{}", ctx);
    expect(out).toMatch(/unknown tool/);
  });

  it("rejects malformed arguments JSON without throwing", async () => {
    const out = await registry.execute("read_file", "not json{", ctx);
    expect(out).toMatch(/not valid JSON/);
  });

  it("rejects zod-invalid arguments and reports the issue path", async () => {
    const out = await registry.execute("read_file", JSON.stringify({}), ctx);
    expect(out).toMatch(/invalid arguments/);
  });

  it("swallows handler errors into a tool-failed result", async () => {
    const out = await registry.execute("read_file", JSON.stringify({ path: "missing.md" }), ctx);
    expect(out).toMatch(/failed/);
    expect(out).toContain("missing.md");
  });
});

describe("fs tools", () => {
  it("write_file then read_file round-trips text", async () => {
    await registry.execute("write_file", JSON.stringify({ path: "a.txt", content: "hello" }), ctx);
    const read = await registry.execute("read_file", JSON.stringify({ path: "a.txt" }), ctx);
    expect(read).toBe("hello");
  });

  it("allows nested relative paths", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    await registry.execute("write_file", JSON.stringify({ path: "sub/b.txt", content: "x" }), ctx);
    const read = await registry.execute("read_file", JSON.stringify({ path: "sub/b.txt" }), ctx);
    expect(read).toBe("x");
  });

  it("refuses paths that escape the workspace root", async () => {
    const out = await registry.execute("read_file", JSON.stringify({ path: "../outside.txt" }), ctx);
    expect(out).toContain("escapes the workspace root");
  });

  it("refuses absolute paths outside the root", async () => {
    const out = await registry.execute("read_file", JSON.stringify({ path: tmpdir() }), ctx);
    expect(out).toContain("escapes the workspace root");
  });

  it("refuses path traversal via encoded separators", async () => {
    const out = await registry.execute("read_file", JSON.stringify({ path: "..\\escape.txt" }), ctx);
    expect(out).toContain("escapes the workspace root");
  });

  it("list_dir reports dirs and files with types", async () => {
    mkdirSync(join(tmp, "sub"), { recursive: true });
    writeFileSync(join(tmp, "f.txt"), "x");
    const out = await registry.execute("list_dir", "{}", ctx);
    expect(out).toContain("dir   sub");
    expect(out).toContain("file  f.txt");
  });

  it("stat reports a file's size", async () => {
    writeFileSync(join(tmp, "f.txt"), "hello");
    const out = await registry.execute("stat", JSON.stringify({ path: "f.txt" }), ctx);
    expect(out).toContain("size: 5");
  });

  it("glob matches **/*.ts across subdirs", async () => {
    mkdirSync(join(tmp, "src", "tools"), { recursive: true });
    writeFileSync(join(tmp, "src", "index.ts"), "a");
    writeFileSync(join(tmp, "src", "tools", "x.ts"), "b");
    writeFileSync(join(tmp, "README.md"), "c");
    const out = await registry.execute("glob", JSON.stringify({ pattern: "**/*.ts" }), ctx);
    expect(out).toContain("src/index.ts");
    expect(out).toContain("src/tools/x.ts");
    expect(out).not.toContain("README.md");
  });
});

describe("globToRegExp", () => {
  it("does not let a plain * cross a slash", () => {
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
  });
  it("** crosses directories", () => {
    expect(globToRegExp("**/*.ts").test("src/tools/a.ts")).toBe(true);
  });
  it("matches ? as a single char", () => {
    expect(globToRegExp("?.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("?.ts").test("ab.ts")).toBe(false);
  });
});

describe("patch tool", () => {
  it("replaces a unique occurrence", async () => {
    writeFileSync(join(tmp, "f.txt"), "one two one");
    const out = await registry.execute(
      "patch",
      JSON.stringify({ path: "f.txt", hunks: [{ oldText: "two", newText: "TWO" }] }),
      ctx,
    );
    expect(out).toContain("1 hunk(s) applied");
    expect((await registry.execute("read_file", JSON.stringify({ path: "f.txt" }), ctx))).toBe("one TWO one");
  });

  it("applies multiple hunks in order", async () => {
    writeFileSync(join(tmp, "f.txt"), "a b");
    await registry.execute(
      "patch",
      JSON.stringify({
        path: "f.txt",
        hunks: [
          { oldText: "a", newText: "A" },
          { oldText: "B", newText: "b" },
        ],
      }),
      ctx,
    );
    // one hunk never matched — whole patch is a no-op
    expect((await registry.execute("read_file", JSON.stringify({ path: "f.txt" }), ctx))).toBe("a b");
  });

  it("fails atomically when a hunk is ambiguous", async () => {
    writeFileSync(join(tmp, "f.txt"), "x x");
    const out = await registry.execute(
      "patch",
      JSON.stringify({ path: "f.txt", hunks: [{ oldText: "x", newText: "y" }] }),
      ctx,
    );
    expect(out).toContain("ambig");
    expect((await registry.execute("read_file", JSON.stringify({ path: "f.txt" }), ctx))).toBe("x x");
  });
});

describe("bash tool", () => {
  it("is gated when allowBash is false", async () => {
    const out = await registry.execute("bash", JSON.stringify({ command: "echo hi" }), ctx);
    expect(out).toContain("shell disabled");
  });

  it("runs commands when allowBash is true", async () => {
    const allowed: ToolContext = { ...ctx, allowBash: true };
    const out = await registry.execute("bash", JSON.stringify({ command: "echo hi" }), allowed);
    expect(out).toContain("hi");
  });
});

describe("web tool", () => {
  it("refuses non-http schemes", async () => {
    const out = await registry.execute("fetch_url", JSON.stringify({ url: "file:///etc/passwd" }), ctx);
    expect(out).toContain("only http(s)");
  });
});

describe("git tools", () => {
  it("reports when the workspace is not a git repo", async () => {
    const out = await registry.execute("git_status", "{}", ctx);
    expect(out).toMatch(/fatal|not a git repository|exit 128/i);
  });

  // Each tool must actually WORK inside a real repository. The non-repo test
  // above passes for a tool that is entirely broken, because "not a git
  // repository" is also what a usage error looks like: `git status` rejects
  // `--no-ext-diff`, and that shipped green until this test existed.
  describe("against a real repository", () => {
    const git = async (args: string[], cwd: string): Promise<string> => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      return (await promisify(execFile)("git", args, { cwd })).stdout;
    };

    beforeEach(async () => {
      await git(["init", "-q"], tmp);
      writeFileSync(join(tmp, "a.txt"), "hello\n", "utf8");
      await git(["config", "user.email", "t@example.com"], tmp);
      await git(["config", "user.name", "t"], tmp);
      await git(["add", "a.txt"], tmp);
      await git(["commit", "-q", "-m", "init"], tmp);
    });

    it("git_status returns real status output, not a usage error", async () => {
      writeFileSync(join(tmp, "a.txt"), "changed\n", "utf8");
      const out = await registry.execute("git_status", "{}", ctx);
      expect(out).not.toMatch(/unknown option|usage: git/i);
      expect(out).toContain("a.txt");
    });

    it("git_log returns real output", async () => {
      const out = await registry.execute("git_log", "{}", ctx);
      expect(out).not.toMatch(/unknown option|usage: git/i);
      expect(out).toContain("init");
    });

    it("git_diff returns a real diff", async () => {
      writeFileSync(join(tmp, "a.txt"), "changed\n", "utf8");
      const out = await registry.execute("git_diff", "{}", ctx);
      expect(out).not.toMatch(/unknown option|usage: git/i);
      expect(out).toContain("a.txt");
    });

    it("git_show returns file content", async () => {
      const out = await registry.execute("git_show", JSON.stringify({ path: "a.txt" }), ctx);
      expect(out).not.toMatch(/unknown option|usage: git/i);
      expect(out).toContain("hello");
    });

    // `core.fsmonitor` is the same threat as the diff-driver vector -- a
    // repo-local .git/config entry that git EXECUTES -- and it is reachable by
    // `git status` and `git diff` alike, so `-c core.fsmonitor=false` is
    // required. Without it, a write_file into .git/config is code execution.
    //
    // The observable is that git ATTEMPTS the hook and reports it. We do not
    // need the payload to run: the attempt itself is the vulnerability, and it
    // is observable on every platform, including Windows, where a .cmd payload
    // is not reliably executed by git's hook machinery.
    it("never attempts to run a repo-local core.fsmonitor program", async () => {
      const missing = join(tmp, "definitely-not-here-monitor.exe");
      await git(["config", "core.fsmonitor", missing], tmp);

      for (const [tool, args] of [
        ["git_status", "{}"],
        ["git_diff", "{}"],
        ["git_log", "{}"],
        ["git_show", JSON.stringify({ path: "a.txt" })],
      ] as const) {
        const out = await registry.execute(tool, args, ctx);
        expect(out, `${tool} must not invoke core.fsmonitor`).not.toContain("definitely-not-here-monitor");
      }
    });

    // Control: prove the attempt is detectable at all, so the test above cannot
    // pass vacuously. Git surfaces the failed hook on stderr.
    it("CONTROL: git does report a core.fsmonitor it was told to run", async () => {
      const missing = join(tmp, "definitely-not-here-monitor.exe");
      await git(["config", "core.fsmonitor", missing], tmp);
      // No `-c core.fsmonitor=false` here, so git tries the hook.
      let stderr = "";
      try {
        await git(["status", "--short"], tmp);
      } catch (err) {
        stderr = (err as { stderr?: string }).stderr ?? "";
      }
      // Git may or may not treat it as fatal, but it always says something.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const res = await promisify(execFile)("git", ["status", "--short"], { cwd: tmp }).catch(
        (e: { stderr?: string }) => ({ stdout: "", stderr: e.stderr ?? "" }),
      );
      expect(`${stderr}${(res as { stderr?: string }).stderr ?? ""}`).toContain("definitely-not-here-monitor");
    });
  });
});