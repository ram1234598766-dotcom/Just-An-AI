import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/tools/index.js";
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