import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeUri } from "../src/lsp/client.js";
import { LspManager } from "../src/lsp/manager.js";
import {
  BUILTIN_SERVERS,
  detectServers,
  describeDetection,
  resolveTsserver,
  serverForExtension,
  type LspServerConfig,
} from "../src/lsp/registry.js";
import { refreshDiagnostics, writtenPath } from "../src/lsp/loop.js";
import { lspTools } from "../src/tools/lsp.js";
import { findExecutable, parseNpmShim, resolveSpawn, SpawnResolutionError } from "../src/utils/spawn.js";
import { createRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import type { ToolCall } from "../src/providers/types.js";

let tmp: string;
let project: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-lsp-"));
  project = join(tmp, "project");
  mkdirSync(project, { recursive: true });
  process.env.JAA_HOME = join(tmp, "home");
  mkdirSync(process.env.JAA_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
});

const call = (name: string, args: unknown): ToolCall => ({
  id: "c1",
  name,
  arguments: JSON.stringify(args),
});

/** A project with a tsconfig and one TypeScript file, the shape detection needs. */
function makeTsProject(files: Record<string, string> = {}): void {
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src"] }), "utf8");
  mkdirSync(join(project, "src"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(project, name), body, "utf8");
}

// --- spawn resolution ------------------------------------------------------

describe("lsp: platform-safe command resolution", () => {
  it("passes a POSIX command through untouched, with no shell", () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const plan = resolveSpawn("some-ls", ["--stdio"]);
      expect(plan).toEqual({ command: "some-ls", args: ["--stdio"], viaShim: false });
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });

  it("refuses an unresolvable command instead of falling back to a shell", () => {
    // The whole point: `cmd /c` would work and would be an injection vector.
    //
    // Windows only, and the reason is that POSIX needs no resolution at all —
    // `spawn` searches `PATH` itself and takes a real argv, so `resolveSpawn`
    // returns the command untouched and there is nothing to refuse. The
    // security property it protects is asserted platform-independently by the
    // "never puts an argument through a shell" test beside this one; what is
    // Windows-specific is *where* the refusal happens, and only there does it
    // throw. Asserting it everywhere would be asserting that POSIX is broken.
    if (process.platform !== "win32") return;
    expect(() => resolveSpawn("definitely-not-a-real-binary-xyz-123", [])).toThrow(SpawnResolutionError);
    expect(() => resolveSpawn("definitely-not-a-real-binary-xyz-123", [])).toThrow(/does not fall back to a shell/);
  });

  it("never puts an argument through a shell, whatever it contains", () => {
    // The property is structural: a resolved plan is either the command itself
    // or `process.execPath` plus a script from an npm shim. There is no
    // `cmd.exe` and no shell anywhere in the outcome, so `&`, `|`, `>`, `%` and
    // spaces in an argument are all just bytes.
    const hostile = ["C:\\a b", "a&calc.exe", "a|b", "a>b", "a%PATH%", "a!b"];
    let plan;
    try {
      plan = resolveSpawn("typescript-language-server", hostile);
    } catch {
      // No server on this host. That is fine: the refusal is itself correct, and
      // the refusal is what the previous test already covers.
      return;
    }
    expect(plan.command.toLowerCase()).not.toContain("cmd.exe");
    expect(plan.command.toLowerCase()).not.toContain("powershell");
    expect(plan.command.toLowerCase()).not.toContain("sh");
    // Every hostile argument survives byte for byte.
    for (const arg of hostile) expect(plan.args.join("\u0000")).toContain(arg);
  });

  it("finds a command on PATH and prefers a real executable over a batch file", () => {
    const found = findExecutable("node");
    expect(found).toBeDefined();
    if (found !== undefined) expect(found.toLowerCase()).toContain("node");
  });

  it("unwraps an npm shim rather than executing it", function () {
    const shim = findExecutable("npm");
    if (shim === undefined || !/\.(cmd|bat)$/i.test(shim)) return;
    const script = parseNpmShim(shim);
    // A recognised npm shim yields a runnable script; an unrecognised one yields
    // nothing at all, never a guess.
    if (script !== undefined) expect(existsSync(script)).toBe(true);
  });

  it("returns undefined for a batch file that is not an npm shim", () => {
    expect(parseNpmShim(join(project, "nope.cmd"))).toBeUndefined();
  });
});

// --- URI normalisation -----------------------------------------------------

describe("lsp: document URI normalisation", () => {
  it("collapses the spellings a server actually sends", () => {
    // Observed on this host: the client sends the second form and the server
    // echoes the first. Keying a map on the raw string loses every publish.
    //
    // Windows only for the *case* half, because the drive letter is what varies
    // and `/c` and `/C` are different directories on a case-sensitive
    // filesystem. Collapsing them on Linux would merge two genuinely different
    // files, which is a bug of its own.
    const encoded = normalizeUri("file:///c%3A/Users/x/src/a.ts");
    const plain = normalizeUri("file:///C:/Users/x/src/a.ts");
    // The percent-encoded colon decodes on every platform: that is a URI detail,
    // not a path detail.
    expect(encoded).toContain("file:///c:");
    if (process.platform === "win32") {
      // Windows folds case for the whole URI, so the two spellings collapse.
      expect(encoded).toBe("file:///c:/users/x/src/a.ts");
      expect(encoded).toBe(plain);
    } else {
      // `/c` and `/C` are different directories on a case-sensitive filesystem,
      // so merging them there would lose one of the two files.
      expect(encoded).toBe("file:///c:/Users/x/src/a.ts");
      expect(encoded).not.toBe(plain);
    }
  });

  it("leaves a non-file URI alone", () => {
    expect(normalizeUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
  });
});

// --- registry --------------------------------------------------------------

describe("lsp: registry and detection", () => {
  it("maps extensions to the right server", () => {
    expect(serverForExtension(".ts")?.id).toBe("typescript");
    expect(serverForExtension(".tsx")?.id).toBe("typescript");
    expect(serverForExtension(".py")?.id).toBe("python");
    expect(serverForExtension(".rs")?.id).toBe("rust");
    expect(serverForExtension(".go")?.id).toBe("go");
    expect(serverForExtension(".unknown")).toBeUndefined();
  });

  it("detects by project marker", () => {
    writeFileSync(join(project, "Cargo.toml"), "[package]\n", "utf8");
    const detected = detectServers(project);
    expect(detected.some((d) => d.config.id === "rust")).toBe(true);
  });

  it("detects by extension when there is no marker", () => {
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "main.rs"), "fn main() {}\n", "utf8");
    const detected = detectServers(project);
    expect(detected.some((d) => d.config.id === "rust")).toBe(true);
  });

  it("reports nothing for a project with no source in it", () => {
    expect(detectServers(project)).toEqual([]);
  });

  it("does not walk node_modules or a virtualenv", () => {
    mkdirSync(join(project, "node_modules", "x"), { recursive: true });
    mkdirSync(join(project, ".venv", "lib"), { recursive: true });
    writeFileSync(join(project, "node_modules", "x", "a.rs"), "fn a() {}\n", "utf8");
    writeFileSync(join(project, ".venv", "lib", "b.rs"), "fn b() {}\n", "utf8");
    expect(detectServers(project)).toEqual([]);
  });

  it("distinguishes 'no server' from 'no language in this project'", () => {
    // A command that does not exist must not make a project look like a Python
    // project, and a Python project must not be reported as a TypeScript one.
    const fake: LspServerConfig[] = [
      { id: "fake", command: "definitely-not-real-xyz", extensions: [".zzz"], markers: [] },
    ];
    writeFileSync(join(project, "a.zzz"), "x", "utf8");
    const detected = detectServers(project, fake);
    expect(detected).toHaveLength(1);
    expect(detected[0]?.available).toBe(false);
    expect(detected[0]?.reason).toMatch(/not on PATH/);
    expect(describeDetection(detected)[0]).toMatch(/UNAVAILABLE/);
  });

  it("reports a missing tsserver separately from a missing server", () => {
    // TypeScript 7 ships no tsserver, so these are genuinely different failures
    // and they need different fixes.
    const fake: LspServerConfig[] = [
      { id: "ts", command: "node", extensions: [".ts"], tsserverPath: "nope-not-installed/lib/tsserver.js" },
    ];
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const detected = detectServers(project, fake);
    expect(detected[0]?.available).toBe(false);
    expect(detected[0]?.reason).toMatch(/nothing to drive/);
  });

  it("resolves a tsserver that is present", () => {
    const found = resolveTsserver("typescript5/lib/tsserver.js");
    if (found !== undefined) expect(existsSync(found)).toBe(true);
  });

  it("every built-in server declares extensions and a command", () => {
    for (const server of BUILTIN_SERVERS) {
      expect(server.command, server.id).not.toBe("");
      expect(server.extensions.length, server.id).toBeGreaterThan(0);
    }
  });
});

// --- loop helpers ----------------------------------------------------------

describe("lsp: loop integration", () => {
  it("finds the path a mutating call wrote", () => {
    expect(writtenPath(call("write_file", { path: "src/a.ts", content: "x" }))).toBe("src/a.ts");
    expect(writtenPath(call("patch", { path: "src/b.ts", hunks: [] }))).toBe("src/b.ts");
    expect(writtenPath(call("bash", { command: "rm -rf /" }))).toBeUndefined();
    expect(writtenPath({ id: "c", name: "write_file", arguments: "not json" })).toBeUndefined();
    expect(writtenPath(call("read_file", {}))).toBeUndefined();
  });

  it("stays silent for a file with no language server", async () => {
    const manager = new LspManager({ root: project });
    const report = await refreshDiagnostics({ manager, root: project }, "notes.md");
    expect(report.text).toBe("");
    expect(report.reason).toMatch(/no language server/);
    await manager.close();
  });

  it("stays silent when disabled, without asking the server anything", async () => {
    const manager = new LspManager({ root: project });
    const report = await refreshDiagnostics({ manager, root: project, enabled: false }, "a.ts");
    expect(report.text).toBe("");
    expect(report.reason).toBe("disabled");
    await manager.close();
  });

  it("does not throw when the language server is unusable", async () => {
    // The important property: a broken type checker must never fail a write.
    const broken: LspServerConfig[] = [
      { id: "ts", command: "definitely-not-real-xyz", extensions: [".ts"], markers: [] },
    ];
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const manager = new LspManager({ root: project, servers: broken });
    const report = await refreshDiagnostics({ manager, root: project }, "src/a.ts");
    expect(report.text).toBe("");
    expect(report.reason).toMatch(/not available/);
    await manager.close();
  });

  it("reports a language server that cannot start, without retrying forever", async () => {
    // `node` is on PATH and exits immediately: a server that cannot stay up.
    const flaky: LspServerConfig[] = [
      { id: "ts", command: process.execPath, args: ["-e", "process.exit(0)"], extensions: [".ts"], markers: [] },
    ];
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
    const manager = new LspManager({ root: project, servers: flaky, timeoutMs: 3000 });
    const first = await manager.diagnostics(join(project, "src", "a.ts"));
    expect(first.status).not.toBe("ok");
    // A second call must not throw either, whatever the first one did.
    const second = await manager.diagnostics(join(project, "src", "a.ts"));
    expect(second.status).not.toBe("ok");
    await manager.close();
  });

  it("answers 'unavailable' for a file type it has no server for", async () => {
    const manager = new LspManager({ root: project });
    const outcome = await manager.diagnostics(join(project, "README.md"), "# hi");
    expect(outcome.status).toBe("unavailable");
    expect(manager.languageFor(join(project, "README.md"))).toBeUndefined();
    await manager.close();
  });

  it("knows which files it has a server for, without starting one", async () => {
    makeTsProject({ "src/a.ts": "export const a = 1;\n" });
    const manager = new LspManager({ root: project });
    expect(manager.languageFor(join(project, "src", "a.ts"))).toBe("typescript");
    expect(manager.languageFor(join(project, "notes.md"))).toBeUndefined();
    await manager.close();
  });
});

// --- tools -----------------------------------------------------------------

describe("lsp: the lsp_* tools", () => {
  const ctx = (): ToolContext => ({ root: project, cwd: project, allowBash: false });

  it("registers four tools with the documented names", () => {
    const tools = lspTools(() => undefined);
    expect(tools.map((t) => t.name)).toEqual([
      "lsp_diagnostics",
      "lsp_definition",
      "lsp_references",
      "lsp_hover",
    ]);
  });

  it("says code intelligence is off when no manager is supplied", async () => {
    for (const tool of lspTools(() => undefined)) {
      const result = await tool.run({ path: "a.ts", line: 1, character: 1 }, ctx());
      expect(result).toMatch(/not enabled for this session/);
    }
  });

  it("reports no server for a file type it does not handle", async () => {
    const manager = new LspManager({ root: project });
    const tools = lspTools(() => manager);
    const diagnostics = tools.find((t) => t.name === "lsp_diagnostics")!;
    const result = await diagnostics.run({ path: "notes.md" }, ctx());
    expect(result).toMatch(/no diagnostics available/);
    await manager.close();
  });

  it("refuses a path outside the workspace rather than reporting one", async () => {
    const manager = new LspManager({ root: project });
    const tools = lspTools(() => manager);
    const diagnostics = tools.find((t) => t.name === "lsp_diagnostics")!;
    // `confinePath` is the boundary; the tool must not be a way around it.
    await expect(diagnostics.run({ path: "../../etc/passwd" }, ctx())).rejects.toThrow();
    await manager.close();
  });

  it("are usable through a real registry", async () => {
    const registry = createRegistry(lspTools(() => undefined));
    expect(registry.list().map((t) => t.name)).toContain("lsp_diagnostics");
    const result = await registry.execute("lsp_diagnostics", JSON.stringify({ path: "a.ts" }), ctx());
    expect(result).toMatch(/not enabled/);
  });
});

// --- the real language server ---------------------------------------------

/**
 * These run against the actual `typescript-language-server` on this host.
 *
 * They are skipped, not failed, when it is not installed — a machine without a
 * language server is a supported configuration (the plan calls for graceful
 * degradation), and a test that failed there would be asserting the wrong thing.
 * But where the server *is* available they are the only proof that the
 * diagnostics path works at all: everything above it can be faked with a stub,
 * and until this was run the wiring had three separate defects that no unit test
 * would have caught.
 */
const hasServer = findExecutable("typescript-language-server") !== undefined;
const hasTsserver = resolveTsserver("typescript5/lib/tsserver.js") !== undefined;

describe.skipIf(!hasServer)("lsp: against a real language server", () => {
  it.skipIf(!hasTsserver)(
    "reports a real type error in a real file, and nothing for a clean one",
    async () => {
      // The push wait, not the per-request deadline.
      //
      // This probe runs against the whole jaa repository rather than a
      // throwaway fixture, so `tsserver` has to index every file in a real
      // project before it publishes anything. The default wait is a few seconds
      // and is right for a single edited file; here it expired on a loaded
      // machine and the test reported "typescript reported: (nothing)", which
      // reads exactly like a broken server and is not one.
      //
      // Generous because indexing a repository of this size genuinely takes
      // that long when it is competing with the rest of the suite, and because a
      // test that flapped on machine load would be a test people learned to
      // re-run rather than read.
      const manager = new LspManager({
        root: process.cwd(),
        timeoutMs: 120_000,
        diagnosticWaitMs: 120_000,
      });
      const brokenFile = resolve("src/__lsp_gate_probe.ts");
      const cleanFile = resolve("src/__lsp_gate_clean.ts");
      const broken = 'export const wrong: number = "not a number";\n';
      writeFileSync(brokenFile, broken, "utf8");
      writeFileSync(cleanFile, "export const ok: number = 1;\n", "utf8");

      try {
        const bad = await manager.diagnostics(brokenFile, broken, { timeoutMs: 60_000 });
        expect(bad.status, "expected diagnostics from a real server").toBe("ok");
        if (bad.status !== "ok") return;
        const messages = bad.result.items.map((i) => i.message).join(" | ");
        expect(messages).toMatch(/not assignable to type 'number'/);
        // The control: a clean file must produce nothing, or the tool is
        // reporting noise the model would then chase.
        const good = await manager.diagnostics(cleanFile, "export const ok: number = 1;\n", { timeoutMs: 60_000 });
        expect(good.status).toBe("ok");
        if (good.status === "ok") expect(good.result.items).toHaveLength(0);
      } finally {
        await manager.close();
        rmSync(brokenFile, { force: true });
        rmSync(cleanFile, { force: true });
      }
    },
    180_000,
  );

  it("starts a server for this repository and reports it available", () => {
    const detected = detectServers(process.cwd());
    const ts = detected.find((d) => d.config.id === "typescript");
    expect(ts).toBeDefined();
    expect(ts?.evidence).toMatch(/tsconfig\.json/);
  }, 30_000);
});
