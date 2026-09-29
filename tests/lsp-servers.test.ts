import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent/loop.js";
import { appendMessages, createSession, loadSession, saveSession } from "../src/agent/session.js";
import { LspManager } from "../src/lsp/manager.js";
import { withDiagnostics } from "../src/lsp/loop.js";
import { LspClient } from "../src/lsp/client.js";
import { BUILTIN_SERVERS, detectServers, resolveTsserver } from "../src/lsp/registry.js";
import { findExecutable } from "../src/utils/spawn.js";
import type { ChatMessage, ProviderAdapter, ResolvedModel, ToolCall } from "../src/providers/types.js";

let tmp: string;
let project: string;
const originalHome = process.env.JAA_HOME;

/**
 * A temp root with the 8.3 short name expanded away.
 *
 * `os.tmpdir()` returns `C:\Users\MRITYU~1\...` on this host, and gopls cannot
 * match a file addressed by an 8.3 alias to its own build graph — it answers
 * "No active builds contain <path>" and the probe fails for a reason that has
 * nothing to do with jaa. Production is unaffected: `confinePath` canonicalises
 * every tool path through `realpathSync.native` before it becomes a URI, so this
 * only ever bit the fixture.
 */
function longTempRoot(): string {
  return join(realpathSync.native(tmpdir()), `jaa-lsp2-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`);
}

beforeEach(() => {
  tmp = mkdtempSync(longTempRoot());
  project = join(tmp, "project");
  mkdirSync(project, { recursive: true });
  process.env.JAA_HOME = join(tmp, "home");
  mkdirSync(process.env.JAA_HOME, { recursive: true });
});

afterEach(() => {
  // A language server may still hold the directory open after `close()` returns,
  // and on Windows that makes removal fail. Cleanup is not an assertion: a run
  // whose diagnostics already passed must not be reported as a failure because a
  // temp directory could not be deleted.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Left behind under the OS temp directory; harmless and self-limiting.
  }
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
});

const call = (name: string, args: unknown): ToolCall => ({ id: "c1", name, arguments: JSON.stringify(args) });

/** A manager whose diagnostics are fixed, so the assertions are about plumbing. */
function fakeManager(diagnostics: string): LspManager {
  return {
    languageFor: (p: string) => (p.endsWith(".ts") ? "typescript" : undefined),
    hasServerFor: () => true,
    diagnostics: async (p: string) =>
      p.endsWith(".ts")
        ? {
            status: "ok" as const,
            language: "typescript",
            result: {
              kind: "full" as const,
              items:
                diagnostics === ""
                  ? []
                  : [
                      {
                        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                        severity: 1,
                        message: diagnostics,
                      },
                    ],
            },
          }
        : { status: "unavailable" as const, reason: "no server" },
    close: async () => undefined,
  } as unknown as LspManager;
}

// --- L6: does the compiler's verdict reach the saved session? --------------

describe("lsp: the compiler's verdict is persisted, not just shown", () => {
  it("appends diagnostics to the tool result the loop stores", async () => {
    const manager = fakeManager("Type 'string' is not assignable to type 'number'.");
    const inner = async (): Promise<string> => "wrote 40 bytes to src/a.ts";
    const execute = withDiagnostics(inner, { manager, root: project });

    const result = await execute(call("write_file", { path: "src/a.ts", content: "x" }));
    expect(result).toContain("wrote 40 bytes");
    expect(result).toContain("[lsp] src/a.ts");
    expect(result).toContain("not assignable to type 'number'");
  });

  it("survives the full loop into a saved, reloaded session", async () => {
    // This is the property L6 claimed was missing. It is not missing: the tool
    // result is in `result.messages`, the persisted delta is a slice of that
    // array, and the wrapper's text is written into the result the loop stores.
    // So `jaa session show` replays what the compiler said.
    const manager = fakeManager("Type 'string' is not assignable to type 'number'.");

    const replies: ChatMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: "x" }) }] },
      { role: "assistant", content: "done" },
    ];
    let turn = 0;
    const adapter: ProviderAdapter = {
      id: "scripted",
      async chat() {
        const message = replies[turn++]!;
        return { message, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "scripted" };
      },
    };
    const model: ResolvedModel = { provider: "scripted", model: "m", adapter };

    const session = createSession({ provider: "scripted", model: "m" });
    const initial = [...session.messages, { role: "user" as const, content: "fix the type error" }];

    const result = await runAgentLoop({
      model,
      messages: initial,
      maxTurns: 2,
      tools: [],
      executeTool: withDiagnostics(async () => "wrote 1 bytes to src/a.ts", { manager, root: project }),
    });

    // Exactly what `ask` does before writing.
    const delta = result.messages.slice(initial.length);
    appendMessages(session, ...delta);
    saveSession(session);

    const reloaded = loadSession(session.id);
    const toolMessages = reloaded?.messages.filter((m) => m.role === "tool") ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("[lsp] src/a.ts");
    expect(toolMessages[0]?.content).toContain("not assignable to type 'number'");
    // And the agent's own final claim is still there, side by side — which is the
    // point: the transcript records what was asserted *and* what was found.
    expect(reloaded?.messages.some((m) => m.role === "assistant" && m.content === "done")).toBe(true);
  });

  it("appends nothing for a clean file, so a successful write is not padded", async () => {
    const manager = fakeManager("");
    const execute = withDiagnostics(async () => "wrote 1 bytes", { manager, root: project });
    expect(await execute(call("write_file", { path: "src/a.ts", content: "x" }))).toBe("wrote 1 bytes");
  });

  it("leaves a non-mutating call alone entirely", async () => {
    const manager = fakeManager("something is wrong");
    const execute = withDiagnostics(async () => "file contents", { manager, root: project });
    expect(await execute(call("read_file", { path: "src/a.ts" }))).toBe("file contents");
  });

  it("leaves a mutating call alone when it names no file", async () => {
    const manager = fakeManager("something is wrong");
    const execute = withDiagnostics(async () => "ls output", { manager, root: project });
    expect(await execute(call("bash", { command: "ls" }))).toBe("ls output");
  });

  it("reports through the callback so a run can summarise it", async () => {
    const manager = fakeManager("a problem");
    const seen: Array<{ path: string; count: number }> = [];
    const execute = withDiagnostics(
      async () => "ok",
      { manager, root: project },
      (r) => {
        if (r.text !== "") seen.push({ path: r.path, count: r.count });
      },
    );
    await execute(call("write_file", { path: "src/a.ts", content: "x" }));
    expect(seen).toEqual([{ path: "src/a.ts", count: 1 }]);
  });

  it("passes the call through the permission gate exactly once", async () => {
    // The wrapper is applied to an already-gated executor, so the count of inner
    // invocations is the count of calls — not doubled, and not bypassed.
    const manager = fakeManager("a problem");
    let innerCalls = 0;
    const execute = withDiagnostics(
      async () => {
        innerCalls++;
        return "ok";
      },
      { manager, root: project },
    );
    await execute(call("write_file", { path: "src/a.ts", content: "x" }));
    expect(innerCalls).toBe(1);
  });

  it("uses the caller's mutating-tool list when one is given", async () => {
    // The default is the permission engine's own list, so a snapshot and a
    // diagnostics refresh cannot disagree about which calls change a file. A
    // caller can narrow it, and a tool outside that list is left alone.
    const manager = fakeManager("a problem");
    const narrow = withDiagnostics(async () => "ok", { manager, root: project, mutatingTools: ["patch"] });
    expect(await narrow(call("write_file", { path: "src/a.ts", content: "x" }))).toBe("ok");

    const wider = withDiagnostics(async () => "ok", { manager, root: project, mutatingTools: ["write_file"] });
    expect(await wider(call("write_file", { path: "src/a.ts", content: "x" }))).toContain("[lsp]");
  });
});

// --- the other registry entries, against real servers ---------------------

/**
 * Every built-in server is exercised against a real file containing a real
 * error, using the real server, and the result is recorded.
 *
 * This is the honest version of "wired but untested". A registry entry that
 * cannot be verified on this host is reported as skipped with the reason, rather
 * than counted as working — which is the whole point of running it.
 */
interface Probe {
  id: string;
  /** Files that make a directory a real project for this language. */
  setup: Record<string, string>;
  /** The file to write, relative to the probe project. */
  file: string;
  /** A clean counterpart, relative to the probe project. */
  cleanFile: string;
  broken: string;
  clean: string;
  /** A substring that must appear in some diagnostic message. */
  expect: RegExp;
  /** Extra initialisation options some servers need. */
  initOptions?: Record<string, unknown>;
  /** Overrides the command, where the config's is not the server. */
  command?: string;
  args?: string[];
}

/**
 * The fixtures are real projects, not a file dropped in an empty directory.
 *
 * Every one of these failed the first time with a fixture that was nearly right,
 * and the failure was a *server* reporting a genuine inability rather than a
 * product bug — which is exactly the kind of thing this suite exists to surface:
 *
 *   - `go.mod` is not TOML. It needs `module p` and a `go` directive, or gopls
 *     says "No active builds contain <file>" and there is no crate to attach to.
 *   - A cargo project needs the binary under `src/`, or rust-analyzer has no
 *     target.
 *   - `compile_commands.json` is a compilation *database* — an array of entries
 *     with `directory` and `file` — not an object. clangd ignores `{}` and
 *     publishes nothing.
 *   - pyright's server is `pyright-langserver`, and it exits immediately without
 *     `--stdio`. The `pyright` on `PATH` is the CLI wrapper.
 */
const PROBES: Probe[] = [
  {
    id: "typescript",
    setup: { "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["*.ts"] }) },
    file: "bad.ts",
    cleanFile: "clean.ts",
    broken: 'export const wrong: number = "not a number";\n',
    clean: "export const fine: number = 1;\n",
    expect: /not assignable to type ['"]?number/i,
    initOptions: { tsserver: { path: resolveTsserver("typescript5/lib/tsserver.js") } },
  },
  {
    id: "python",
    setup: { "pyproject.toml": '[project]\nname = "p"\nversion = "0.1.0"\n' },
    file: "bad.py",
    cleanFile: "clean.py",
    broken: "x: int = 'not an int'\n",
    clean: "x: int = 1\n",
    expect: /not assignable to declared type ["']?int/i,
    command: "pyright-langserver",
    args: ["--stdio"],
  },
  {
    id: "go",
    setup: { "go.mod": "module p\n\ngo 1.21\n" },
    file: "bad.go",
    // A different function name and no `main`: two `func main` in one package is
    // a redeclaration, which is a real diagnostic and would make the control
    // file fail for a reason that has nothing to do with type checking.
    cleanFile: "clean.go",
    broken: 'package main\n\nfunc main() { var x int = "nope"; _ = x }\n',
    clean: "package main\n\nfunc helper() int { var x int = 1; return x }\n",
    expect: /cannot use .*untyped string/i,
    command: "gopls",
    args: ["serve"],
  },
  {
    id: "cpp",
    // Filled in at run time: the database entry has to name the real path.
    setup: {},
    file: "bad.cpp",
    cleanFile: "clean.cpp",
    broken: 'int main() { int x = "nope"; return x; }\n',
    clean: "int main() { int x = 1; return x; }\n",
    expect: /Cannot initialize a variable of type 'int'/,
    command: "clangd",
    args: [],
  },
  {
    // Needs a JDK to run on and a source root to consider the file part of the
    // project. Without the source roots JDT LS reports nothing at all and looks
    // exactly like a clean file, which is the failure this entry is here to
    // prevent.
    id: "java",
    setup: {
      "pom.xml":
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n" +
        "  <modelVersion>4.0.0</modelVersion>\n" +
        "  <groupId>p</groupId>\n" +
        "  <artifactId>p</artifactId>\n" +
        "  <version>0.1.0</version>\n" +
        "  <properties>\n" +
        "    <maven.compiler.source>21</maven.compiler.source>\n" +
        "    <maven.compiler.target>21</maven.compiler.target>\n" +
        "  </properties>\n" +
        "</project>\n",
    },
    file: "src/main/java/Bad.java",
    cleanFile: "src/main/java/Clean.java",
    broken: 'public class Bad { public static void main(String[] a) { int x = "nope"; } }\n',
    clean: "public class Clean { public static void main(String[] a) { int x = 1; System.out.println(x); } }\n",
    expect: /cannot convert from String to int|cannot be converted|incompatible types/i,
    initOptions: { settings: { java: { project: { sourcePaths: ["src"] } } } },
  },
  {
    id: "rust",
    setup: { "Cargo.toml": '[package]\nname = "p"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n' },
    file: "src/main.rs",
    // `src/bin/*.rs` is auto-discovered by cargo as its own binary target.
    // A second `src/*.rs` file is not a target at all in a package with no
    // `[lib]`, and rust-analyzer correctly says "This file is not included
    // anywhere in the workspace" — a true statement that would make the control
    // file useless as a test of type checking.
    cleanFile: "src/bin/clean.rs",
    broken: 'fn main() { let x: i32 = "nope"; let _ = x; }\n',
    clean: "fn main() { let x: i32 = 1; let _ = x; }\n",
    expect: /mismatched types|expected .i32/i,
  },
];

function makeProbeProject(probe: Probe): void {
  for (const [name, body] of Object.entries(probe.setup)) {
    writeFileSync(mkdirp(join(project, name)), body, "utf8");
  }
  writeFileSync(mkdirp(join(project, probe.file)), probe.broken, "utf8");
  writeFileSync(mkdirp(join(project, probe.cleanFile)), probe.clean, "utf8");
  if (probe.id === "cpp") {
    // clangd will not look at a file it has no compilation command for.
    writeFileSync(
      join(project, "compile_commands.json"),
      JSON.stringify([probe.file, probe.cleanFile].map((name) => ({
        directory: project,
        file: join(project, name),
        command: `clang -c ${join(project, name)}`,
      }))),
      "utf8",
    );
  }
}

function mkdirp(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

describe("lsp: every registry entry, against a real server", () => {
  for (const probe of PROBES) {
    const config = BUILTIN_SERVERS.find((s) => s.id === probe.id);
    const command = probe.command ?? config?.command ?? "";
    // Availability is decided the same way `detectServers` decides it, by
    // asking the registry, rather than by a second, subtly different rule here.
    // A probe that skips for one reason and detection says another is a test
    // lying about the product.
    const launchable = config?.resolveLaunch?.();
    const present = launchable !== undefined || findExecutable(command) !== undefined;
    const tsserverOk = probe.id === "typescript" ? resolveTsserver("typescript5/lib/tsserver.js") !== undefined : true;
    // A server whose own declared toolchain is absent is skipped for the same
    // reason `detectServers` marks it unavailable. It is not broken; it is a
    // frontend with nothing to be a frontend of.
    const toolchain = (config?.requires ?? []).every((b) => findExecutable(b) !== undefined);
    const skip = !present || !tsserverOk || !toolchain || config === undefined;

    it.skipIf(skip)(
      `${probe.id}: reports a real error in a real file, and none in a clean one`,
      async () => {
        makeProbeProject(probe);
        const manager = new LspManager({
          root: project,
          servers: config === undefined ? BUILTIN_SERVERS : [config],
          timeoutMs: 120_000,
          diagnosticWaitMs: 90_000,
          createClient: (cfg, options) => {
            // A config may resolve into a different spawnable line than its
            // `command` — JDT LS's `command` is a batch file no process can be
            // spawned as. The resolved launch wins, exactly as it does in the
            // manager's own default.
            const launch = options.launch;
            const client = new LspClient(
              launch?.command ?? command,
              launch?.args ?? probe.args ?? cfg.args ?? [],
              { cwd: options.cwd, timeoutMs: options.timeoutMs },
            );
            if (probe.initOptions !== undefined) client.setInitializationOptions(probe.initOptions);
            return client;
          },
        });

        try {
          const outcome = await manager.diagnostics(join(project, probe.file), probe.broken, { timeoutMs: 90_000 });
          if (outcome.status !== "ok") {
            // A server that cannot start is a *result*, not a silent pass.
            throw new Error(`${probe.id}: server produced no diagnostics (${outcome.status}: ${outcome.reason})`);
          }
          const messages = outcome.result.items.map((i) => i.message).join(" | ");
          expect(messages, `${probe.id} reported: ${messages || "(nothing)"}`).toMatch(probe.expect);

          // The control: the same server on a clean file must report nothing, or
          // the "clean" result means nothing either.
          const clean = await manager.diagnostics(join(project, probe.cleanFile), probe.clean, { timeoutMs: 90_000 });
          expect(clean.status, `${probe.id} control`).toBe("ok");
          if (clean.status === "ok") {
            const cleanMessages = clean.result.items.map((i) => i.message).join(" | ");
            expect(cleanMessages, `${probe.id} reported problems on a clean file`).toBe("");
          }
        } finally {
          await manager.close().catch(() => undefined);
        }
      },
      240_000,
    );
  }

  it("reports which entries this host can actually verify", () => {
    // Not an assertion about behaviour — an assertion about honesty. Every entry
    // must be classifiable, so an unverified one cannot read as working.
    for (const probe of PROBES) {
      const config = BUILTIN_SERVERS.find((s) => s.id === probe.id);
      const launchable = config?.resolveLaunch?.();
      const available = launchable !== undefined || findExecutable(probe.command ?? config?.command ?? "") !== undefined;
      expect(typeof available, probe.id).toBe("boolean");
      if (!available) expect(config?.install, `${probe.id} must say how to install it`).toBeTruthy();
    }
  });

  it("resolves JDT LS into a line a process can actually be spawned as", () => {
    // The launcher on PATH is a batch file that ends in `pause`. It starts, and
    // it is not a thing `spawn` can run, so a config that passed detection on
    // `jdtls` alone would fail at the moment of use instead.
    const java = BUILTIN_SERVERS.find((s) => s.id === "java");
    expect(java?.resolveLaunch, "java must resolve a spawnable line").toBeTypeOf("function");
    const launch = java?.resolveLaunch?.();
    if (launch === undefined) {
      // No JDT LS here; the install hint must say how to get one.
      expect(java?.install).toMatch(/JDT LS/);
      return;
    }
    expect(launch.command).not.toMatch(/\.(bat|cmd|ps1)$/i);
    expect(launch.command).toBe(findExecutable("java"));
    expect(launch.args.join(" ")).toMatch(/org\.eclipse\.jdt\.ls\.core\.id1/);
    expect(launch.args.join(" ")).toMatch(/-data\s+\S/);
    // The workspace is created eagerly so it exists before the server is told
    // to use it, and it is the one thing that must not be left behind.
    expect(launch.cleanupPath).toBeTruthy();
    expect(existsSync(launch.cleanupPath as string), "the -data directory must exist before the server starts").toBe(true);
  });

  it("treats a missing toolchain as unavailable, not as a working server", () => {
    // rust-analyzer is installed on this host and cannot analyse Rust, because
    // there is no cargo. Reporting it as "available" would be the exact lie the
    // `lsp` check in `doctor` exists to avoid.
    const rust = BUILTIN_SERVERS.find((s) => s.id === "rust");
    expect(rust?.requires).toEqual(["cargo"]);
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "Cargo.toml"), '[package]\nname = "p"\nversion = "0.1.0"\n', "utf8");
    const detected = detectServers(project);
    const rustDetected = detected.find((d) => d.config.id === "rust");
    if (findExecutable("cargo") === undefined) {
      expect(rustDetected?.available, "no cargo means rust-analyzer cannot analyse anything").toBe(false);
      expect(rustDetected?.reason).toMatch(/without cargo/);
      expect(rustDetected?.reason).toMatch(/not the same as reporting no errors/);
    }
  });

  it("has a live probe for every registry entry", () => {
    // An entry with no probe is an entry nobody has run. Every wired server now
    // has one; a new entry added without a probe fails here rather than
    // silently reading as working.
    const probed = new Set(PROBES.map((p) => p.id));
    const unprobed = BUILTIN_SERVERS.filter((s) => !probed.has(s.id)).map((s) => s.id);
    expect(unprobed, "add a live probe for this server, or do not ship it").toEqual([]);
  });
});

describe("lsp: detection is honest about a project it can serve", () => {
  it("offers nothing for an empty directory", () => {
    expect(detectServers(project)).toEqual([]);
  });

  it("offers the server for a marker the project actually has", () => {
    writeFileSync(join(project, "Cargo.toml"), "[package]\n", "utf8");
    const detected = detectServers(project);
    expect(detected.map((d) => d.config.id)).toContain("rust");
  });
});
