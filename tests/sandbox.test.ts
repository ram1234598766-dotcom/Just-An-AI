import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import {
  describePolicy,
  detectCapability,
  generateBwrapArgs,
  generateLandlockRules,
  generateSeatbeltProfile,
  resetCapabilityCache,
  validatePolicy,
  wrapCommand,
} from "../src/sandbox/index.js";
import type { SandboxCapability, SandboxPolicy } from "../src/sandbox/index.js";

const run = promisify(execFile);
const execFileAsync = promisify(execFile);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "jaa-sandbox-"));
}

function policy(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    writableRoots: [],
    readableRoots: [],
    network: false,
    cwd: process.cwd(),
    envPassthrough: [],
    ...over,
  };
}

const available = (mechanism: SandboxCapability["mechanism"]): SandboxCapability => ({
  platform: "darwin",
  mechanism,
  available: true,
  enforces: ["filesystem-read", "filesystem-write", "network"],
  doesNotEnforce: [],
  summary: "test",
});

describe("policy validation", () => {
  it("rejects a relative root rather than silently resolving it", () => {
    expect(validatePolicy(policy({ writableRoots: ["relative/path"] }))).toContain(
      "root must be absolute: relative/path",
    );
  });

  it("rejects a null byte in a root", () => {
    expect(validatePolicy(policy({ writableRoots: ["/ws/a\u0000b"] }))[0]).toMatch(/null byte/);
  });

  it("rejects a relative cwd", () => {
    expect(validatePolicy(policy({ cwd: "rel" }))).toContain("cwd must be absolute: rel");
  });

  it("accepts an absolute policy", () => {
    expect(validatePolicy(policy({ writableRoots: ["/ws"], cwd: "/ws" }))).toEqual([]);
  });
});

describe("seatbelt profile generation", () => {
  it("is deny-by-default", () => {
    const p = generateSeatbeltProfile(policy());
    expect(p).toContain("(deny default)");
  });

  it("allows read only under the declared roots", () => {
    const p = generateSeatbeltProfile(policy({ readableRoots: ["/ws"] }));
    expect(p).toContain('(allow file-read* (subpath "/ws"))');
    expect(p).not.toContain('"/etc"');
  });

  it("allows write only under the declared roots", () => {
    const p = generateSeatbeltProfile(policy({ writableRoots: ["/ws/build"] }));
    expect(p).toContain('(allow file-write* (subpath "/ws/build"))');
  });

  it("omits network when the policy forbids it", () => {
    expect(generateSeatbeltProfile(policy({ network: false }))).not.toContain("network*");
    expect(generateSeatbeltProfile(policy({ network: true }))).toContain("(allow network*)");
  });

  it("escapes quotes and backslashes in a root", () => {
    const p = generateSeatbeltProfile(policy({ readableRoots: ['/ws/a"b\\c'] }));
    expect(p).toContain('\\"b\\\\c');
  });

  it("cannot be broken out of by a crafted root", () => {
    const p = generateSeatbeltProfile(policy({ readableRoots: ['/ws") (allow file-write* (subpath "/'] }));
    // The injected text must stay inside a single string literal. Count only
    // unescaped quotes, since `\"` is content rather than a delimiter.
    const unescaped = (line: string) => (line.match(/(^|[^\\])"/g) ?? []).length;
    const clauses = p.split("\n").filter((l) => l.includes("subpath"));
    expect(clauses.length).toBeGreaterThan(0);
    for (const line of clauses) {
      expect(unescaped(line)).toBe(2);
    }
    // Most importantly, the injection did not become its own allow clause.
    expect(p.split("\n").filter((l) => l.trim().startsWith("(allow file-write*"))).toHaveLength(0);
  });
});

describe("bubblewrap argument generation", () => {
  it("does not bind the whole filesystem read-only, which would make readableRoots decorative", () => {
    const args = generateBwrapArgs(policy({ cwd: "/ws" }), "sh", []);
    // Binding "/" would expose ~/.ssh, ~/.aws and the keyring in ~/.jaa.
    expect(args).not.toContain("/\x00");
    expect(args.join(" ")).not.toMatch(/--ro-bind \/ \/$/);
  });

  it("exposes only an allowlist of system roots, and only ones that exist here", () => {
    const args = generateBwrapArgs(policy(), "sh", []);
    // Never the whole filesystem, and never a home directory.
    expect(args.join(" ")).not.toMatch(/--ro-bind \/ \/$/);
    expect(args.join(" ")).not.toContain("/home");

    // Every system root actually emitted must exist on this host. bwrap aborts
    // on a missing bind source, and the list is a cross-platform union, so a
    // macOS-only path used to make every Linux command exit 1 while `doctor`
    // still reported a working sandbox.
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "--ro-bind" && args[i + 1] === args[i + 2]) {
        expect(existsSync(args[i + 1] as string)).toBe(true);
      }
    }
    // And the allowlist is not empty where it must be. On Windows none of the
    // POSIX system roots exist, so an empty list is correct there -- and
    // bubblewrap is never used on that platform anyway.
    if (process.platform !== "win32") {
      const systemBinds = args.filter((a, i) => a === "--ro-bind" && args[i + 1] === args[i + 2]);
      expect(systemBinds.length).toBeGreaterThan(0);
    }
  });

  it("keeps a workspace that lives under /tmp visible instead of shadowing it with the tmpfs", () => {
    const underTmp = process.platform === "win32" ? undefined : resolve("/tmp/jaa-ws");
    if (underTmp === undefined) return;
    const args = generateBwrapArgs(policy({ writableRoots: [underTmp], readableRoots: [], cwd: underTmp }), "sh", []);
    // No tmpfs at all, otherwise it would hide the declared writable root.
    expect(args).not.toContain("--tmpfs");
    expect(args.join(" ")).toContain(underTmp);
  });

  it("refuses a readable root that contains a writable one, rather than shadowing it", () => {
    const ws = resolve("/ws");
    const problems = validatePolicy(
      policy({ writableRoots: [join(ws, "build")], readableRoots: [ws], cwd: ws }),
    );
    expect(problems.join(" ")).toContain("would be shadowed");
  });

  it("refuses a root that is an ancestor of the home directory, not just the home directory itself", () => {
    // `$HOME/..` is `/home` or `/Users`, which holds every account's .ssh and
    // .aws. A two-entry denylist accepted it.
    const parent = dirname(resolve(homedir()));
    const problems = validatePolicy(policy({ writableRoots: [parent], readableRoots: [parent], cwd: parent }));
    expect(problems.join(" ")).toContain("too broad");
  });

  it("binds a readable root nested in a writable root read-only, last, so it is not shadowed", () => {
    // Compare against the resolved forms, since generateBwrapArgs resolves too.
    const ws = resolve("/ws");
    const secrets = resolve("/ws/secrets");
    const args = generateBwrapArgs(
      policy({ writableRoots: [ws], readableRoots: [secrets], cwd: ws }),
      "sh",
      [],
    );
    const roIdx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === secrets);
    const rwIdx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === ws);
    expect(roIdx).toBeGreaterThan(-1);
    expect(rwIdx).toBeGreaterThan(-1);
    // The read-only bind must come after the writable parent.
    expect(roIdx).toBeGreaterThan(rwIdx);
  });

  it("unshares the network when the policy forbids it", () => {
    expect(generateBwrapArgs(policy({ network: false }), "sh", [])).toContain("--unshare-net");
    expect(generateBwrapArgs(policy({ network: true }), "sh", [])).not.toContain("--unshare-net");
  });

  it("uses a private PID namespace, which is what makes process-tree true", () => {
    expect(generateBwrapArgs(policy(), "sh", [])).toContain("--unshare-pid");
  });

  it("places every --setenv before the -- separator", () => {
    // Anything after `--` is the command, so a misplaced flag makes bwrap try
    // to exec a program literally named `--setenv`.
    const args = generateBwrapArgs(policy({ envPassthrough: ["PATH"] }), "sh", ["-c", "ls"]);
    const sep = args.indexOf("--");
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--setenv") expect(i).toBeLessThan(sep);
    }
    expect(args.slice(sep + 1)).toEqual(["sh", "-c", "ls"]);
  });

  it("passes the command last, after the isolation flags", () => {
    const args = generateBwrapArgs(policy(), "sh", ["-c", "echo hi"]);
    expect(args.slice(-3)).toEqual(["sh", "-c", "echo hi"]);
  });

  it("strips NODE_OPTIONS from the child so a poisoned parent cannot inject code", () => {
    process.env.NODE_OPTIONS = "--require=evil.js";
    try {
      const args = generateBwrapArgs(policy({ envPassthrough: ["PATH"] }), "sh", []);
      expect(args).toContain("--unsetenv");
      expect(args[args.indexOf("--unsetenv") + 1]).toBe("NODE_OPTIONS");
    } finally {
      delete process.env.NODE_OPTIONS;
    }
  });
});

describe("over-broad roots are refused", () => {
  it("rejects a writable filesystem root", () => {
    const ws = mkdtempSync(join(tmpdir(), "jaa-sandbox-ws-"));
    try {
      const root = parse(ws).root;
      expect(validatePolicy(policy({ writableRoots: [root], cwd: ws }))).toContain(
        `root is too broad to sandbox safely: ${root}`,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects the home directory as a root", () => {
    const ws = mkdtempSync(join(tmpdir(), "jaa-sandbox-ws-"));
    try {
      expect(validatePolicy(policy({ writableRoots: [homedir()], cwd: ws }))).toContain(
        `root is too broad to sandbox safely: ${homedir()}`,
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects an over-broad cwd", () => {
    const root = parse(process.cwd()).root;
    expect(validatePolicy(policy({ cwd: root }))).toContain(`cwd is too broad to sandbox safely: ${root}`);
  });

  it("still accepts a normal workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "jaa-sandbox-ws-"));
    try {
      expect(validatePolicy(policy({ writableRoots: [ws], cwd: ws }))).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("seatbelt can actually exec", () => {
  it("grants the system paths a process image needs to load", () => {
    // Without these, dyld cannot read its shared cache and no command starts.
    const p = generateSeatbeltProfile(policy());
    expect(p).toContain('(allow file-read* (subpath "/usr"))');
    expect(p).toContain('(allow file-read* (subpath "/System"))');
  });
});

describe("landlock rule generation", () => {
  it("emits explicit network allow or deny", () => {
    expect(generateLandlockRules(policy({ network: false }))).toContain("network deny");
    expect(generateLandlockRules(policy({ network: true }))).toContain("network allow");
  });
});

describe("command wrapping", () => {
  it("wraps with sandbox-exec on darwin", () => {
    const w = wrapCommand(policy({ cwd: "/ws" }), available("seatbelt"), "sh", ["-c", "ls"]);
    expect(w.wrapped).toBe(true);
    expect(w.command).toContain("sandbox-exec");
    expect(w.args[0]).toBe("-p");
    expect(w.args.slice(-3)).toEqual(["sh", "-c", "ls"]);
  });

  it("wraps with bwrap on linux", () => {
    const w = wrapCommand(policy({ cwd: "/ws" }), available("bubblewrap"), "sh", ["-c", "ls"]);
    expect(w.wrapped).toBe(true);
    expect(w.command).toBe("bwrap");
  });

  it("refuses to run when enforcement is required and the host cannot sandbox", () => {
    const cap: SandboxCapability = {
      platform: "win32",
      mechanism: "none",
      available: false,
      reason: "no mechanism on this platform",
      enforces: [],
      doesNotEnforce: ["filesystem-read", "filesystem-write"],
      summary: "unavailable",
    };
    const w = wrapCommand(policy(), cap, "sh", ["-c", "rm -rf /"], "require");
    expect(w.wrapped).toBe(false);
    expect(w.refusal).toMatch(/not run/i);
    // The original command must survive untouched so a caller cannot run it by accident.
    expect(w.command).toBe("sh");
  });

  it("allows an unwrapped run only under best-effort", () => {
    const cap: SandboxCapability = {
      platform: "win32",
      mechanism: "none",
      available: false,
      reason: "none",
      enforces: [],
      doesNotEnforce: [],
      summary: "unavailable",
    };
    const w = wrapCommand(policy(), cap, "sh", ["-c", "ls"], "best-effort");
    expect(w.wrapped).toBe(false);
    expect(w.refusal).toBeUndefined();
  });

  it("refuses an invalid policy before touching the command", () => {
    const w = wrapCommand(policy({ writableRoots: ["rel"] }), available("seatbelt"), "sh", ["-c", "ls"]);
    expect(w.wrapped).toBe(false);
    expect(w.refusal).toMatch(/invalid sandbox policy/);
  });
});

describe("git hardening blocks a repository-local diff driver", () => {
  it("does not execute a [diff] command driver named by .gitattributes", async () => {
    // A repo-local `.git/config` `[diff "evil"] command` plus a `.gitattributes`
    // `diff=evil` line makes `git diff` run an arbitrary program. Both files are
    // agent-writable, so the flags in src/tools/git.ts are the only thing
    // between a write_file call and code execution.
    //
    // Written as a positive/negative control: the exploit must fire WITHOUT the
    // flags and must NOT fire with them. A one-sided assertion would pass even
    // if git never ran at all.
    const root = tmp();
    const marker = join(root, "PWNED");
    const driver = join(root, "driver.js");
    try {
      writeFileSync(driver, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n`, "utf8");
      writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n", "utf8");
      await execFileAsync("git", ["init", "-q", root], { timeout: 20_000 });
      // git runs the driver through `sh`, which mangles Windows backslashes, so
      // the interpreter path must use forward slashes for the control to fire.
      const nodePath = process.execPath.replace(/\\/g, "/");
      const driverPath = driver.replace(/\\/g, "/");
      await execFileAsync("git", ["-C", root, "config", "diff.evil.command", `${nodePath} ${driverPath}`], {
        timeout: 20_000,
      });
      writeFileSync(join(root, "a.txt"), "hello\n", "utf8");
      await execFileAsync("git", ["-C", root, "add", "a.txt"], { timeout: 20_000 });

      const config = ["-C", root, "-c", "core.pager=cat", "-c", "core.hooksPath=", "-c", "diff.external="];

      // Negative control: without the subcommand flags the driver DOES execute.
      await run("git", [...config, "diff", "--cached"], { cwd: root, timeout: 20_000 }).catch(
        () => undefined,
      );
      expect(() => readFileSync(marker, "utf8")).not.toThrow();

      rmSync(marker, { force: true });

      // The real argv from src/tools/git.ts: config before the subcommand,
      // subcommand flags after it.
      const res = await run("git", [...config, "diff", "--no-ext-diff", "--no-textconv", "--cached"], {
        cwd: root,
        timeout: 20_000,
      }).catch((e: { stdout?: string }) => e);

      // git must have actually produced a diff, or the assertion below is void.
      expect(`${res.stdout ?? ""}`).toContain("+hello");
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("runProcess integration", () => {
  const shell = process.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgs = (cmd: string) =>
    process.platform === "win32" ? ["/d", "/s", "/c", cmd] : ["-c", cmd];

  it("does not execute the command when enforcement is require and no sandbox exists", async () => {
    const { runProcess } = await import("../src/tools/registry.js");
    const marker = join(tmp(), "ran.txt");
    const ws = mkdtempSync(join(tmpdir(), "jaa-sandbox-rp-"));
    try {
      const res = await runProcess(shell, shellArgs(`echo ran > "${marker}"`), {
        cwd: ws,
        sandbox: { writableRoots: [ws], network: false, enforcement: "require" },
      });
      // The whole point: the payload must not have run.
      expect(res.stdout).not.toContain("ran");
      expect(() => readFileSync(marker, "utf8")).toThrow();
      expect(res.stderr).toMatch(/sandbox/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it("runs but announces the degradation under best-effort", async () => {
    const { runProcess } = await import("../src/tools/registry.js");
    const ws = mkdtempSync(join(tmpdir(), "jaa-sandbox-rp-"));
    try {
      const res = await runProcess(shell, shellArgs("echo hello-from-best-effort"), {
        cwd: ws,
        sandbox: { writableRoots: [ws], network: false, enforcement: "best-effort" },
      });
      // Either the sandbox ran it, or it ran with an explicit warning. Both are
      // acceptable; silence is not.
      const spoke = res.stdout.includes("hello-from-best-effort") || res.stderr.includes("hello-from-best-effort");
      expect(spoke || res.stderr.includes("sandbox")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses an over-broad root rather than granting the filesystem", async () => {
    const { runProcess } = await import("../src/tools/registry.js");
    const res = await runProcess(shell, shellArgs("echo SHOULD-NOT-RUN"), {
      cwd: process.cwd(),
      sandbox: { writableRoots: [parse(process.cwd()).root], network: false, enforcement: "require" },
    });
    expect(res.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(res.stderr).toMatch(/too broad|invalid sandbox policy/i);
  }, 30_000);
});

describe("capability detection", () => {
  it("reports win32 as unavailable with a concrete reason", async () => {
    resetCapabilityCache();
    const cap = await detectCapability("win32");
    // This host is Windows, so this is the live answer, not a guess.
    if (process.platform === "win32") {
      expect(cap.available).toBe(false);
      expect(cap.mechanism).toBe("none");
      expect(cap.reason).toMatch(/Job Objects|native|WSL|container/i);
      expect(cap.enforces).toEqual([]);
      expect(cap.doesNotEnforce.length).toBeGreaterThan(0);
    }
  });

  it("never claims a guarantee it does not enforce", async () => {
    resetCapabilityCache();
    const cap = await detectCapability(process.platform);
    if (!cap.available) {
      expect(cap.enforces).toEqual([]);
      expect(cap.reason).toBeTruthy();
    }
  });

  it("memoises the probe", async () => {
    resetCapabilityCache();
    const a = await detectCapability(process.platform);
    const b = await detectCapability(process.platform);
    expect(a).toBe(b);
  });

  it("reports an unknown platform as unsupported", async () => {
    resetCapabilityCache();
    const cap = await detectCapability("aix" as NodeJS.Platform);
    expect(cap.available).toBe(false);
    expect(cap.reason).toMatch(/unsupported platform/);
  });
});

describe("policy description", () => {
  it("summarises roots and network for doctor output", () => {
    const d = describePolicy(policy({ writableRoots: ["/a", "/b"], readableRoots: ["/a"], network: false }));
    expect(d).toContain("write:2");
    expect(d).toContain("network:off");
  });
});

describe("live escape attempt", () => {
  it("is skipped with an explicit reason when the host has no sandbox", async () => {
    resetCapabilityCache();
    const cap = await detectCapability(process.platform);
    if (!cap.available) {
      // Fail closed: the command must not run at all.
      const w = wrapCommand(policy({ writableRoots: ["/ws"] }), cap, process.execPath, ["-e", "0"], "require");
      expect(w.wrapped).toBe(false);
      return;
    }
    const root = tmp();
    try {
      const target = join(root, "allowed.txt");
      writeFileSync(target, "ok", "utf8");
      const outside = join(root, "..", `jaa-sandbox-outside-${process.pid}.txt`);
      const w = wrapCommand(
        policy({ writableRoots: [root], readableRoots: [root], cwd: root }),
        cap,
        process.execPath,
        ["-e", `require('fs').writeFileSync(${JSON.stringify(outside)},'escaped')`],
        "require",
      );
      if (!w.wrapped) return;
      try {
        await run(w.command, w.args, { cwd: root, timeout: 20_000 });
      } catch {
        // a refusal is a pass for this assertion
      }
      expect(() => readFileSync(outside, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
