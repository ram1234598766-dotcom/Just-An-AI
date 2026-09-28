import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * What the hook-layer messages actually print, as the user sees them.
 *
 * Spawned rather than imported: `src/cli/index.ts` calls `bootstrap()` and
 * `program.parseAsync(process.argv)` at module scope, so importing it would run
 * the CLI. The wording is the deliverable here — a `PreToolUse` deny rule that
 * silently stopped firing is exactly the failure these four messages exist to
 * prevent — so what is asserted has to be the real stdout and stderr of the real
 * command, not a helper's return value.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO_ROOT, "src", "cli", "index.ts");
// tsx's own entry point, run on this process's `node`. Going through `npx` needs a
// shell to be resolvable, which it is not from `execFile` on Windows, and the
// shell is only there to be a second thing that can quote an argument wrongly.
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SPAWN_TIMEOUT = 60_000;

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

let home: string;
let workspace: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jaa-cli-hooks-"));
  workspace = join(home, "workspace");
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  // Windows can still hold a handle on a directory the child just exited from,
  // and a failed cleanup must not fail the suite on top of the real assertion.
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Left behind in the OS temp directory; it is not in the repo and not the
    // real ~/.jaa, so it cannot affect anything but disk usage.
  }
});

/** Spawning tsx and the CLI costs seconds; the default 5s budget is not enough. */
const TEST_TIMEOUT = 60_000;

/** Run the CLI against the temp `JAA_HOME`, from the temp workspace. */
async function jaa(...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [TSX, CLI, ...args], {
      cwd: workspace,
      env: { ...process.env, JAA_HOME: home, CI: "1" },
      timeout: SPAWN_TIMEOUT,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    // `execFile` rejects on a non-zero exit; the output is still the answer.
    const failure = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

/** A `command` handler that prints `payload` on stdout and exits 2. */
function handlerScript(dir: string, name: string, payload: unknown): string {
  const file = join(dir, `${name}.js`);
  writeFileSync(
    file,
    `process.stdin.resume();\nprocess.stdin.on("end", () => {\n` +
      `  process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n` +
      `  process.exitCode = 2;\n});\n`,
  );
  return file;
}

/** Three `PreToolUse` groups: valid, malformed, valid. */
async function writeMixedConfig(): Promise<void> {
  const deny = handlerScript(home, "hook-deny", { decision: "deny", reason: "a demo deny rule fired on Bash" });
  const allow = handlerScript(home, "hook-allow", { decision: "allow", reason: "a demo allow rule fired on Read" });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: "Bash", handlers: [{ kind: "command", command: "node", args: [deny] }] },
          // Malformed: a `command` handler with no `command`.
          { matcher: "Write", handlers: [{ kind: "command" }] },
          { matcher: "Read", handlers: [{ kind: "command", command: "node", args: [allow] }] },
        ],
      },
    }),
  );
}

describe("jaa hooks list reports a skipped group, not a dropped layer", () => {
  it("names the skipped group and still lists the two valid siblings", async () => {
    await writeMixedConfig();
    const { stdout, code } = await jaa("hooks", "list");

    expect(code).toBe(0);
    // The header used to say the layer "was NOT loaded", which is a different
    // and stronger claim than what the loader does: it skips one group and keeps
    // every sibling.
    expect(stdout).not.toContain("these layers were NOT loaded");
    expect(stdout).toContain("skipped (these hook groups were NOT loaded; every other hook in the same file is in force):");
    expect(stdout).toContain("PreToolUse.1.handlers.0.command");
    // Both valid groups are loaded and in force.
    expect(stdout).toContain("matcher: Bash");
    expect(stdout).toContain("matcher: Read");
    expect(stdout).toContain("2 group(s) across 1 event(s)");
  }, TEST_TIMEOUT);

  it("says a layer is out only when the whole file could not be read", async () => {
    writeFileSync(join(home, "config.json"), "{ this is not json");
    const { stdout } = await jaa("hooks", "list");

    expect(stdout).toContain("config errors (these layers could not be read, so no hook in them was loaded):");
    expect(stdout).toContain("not valid JSON");
    expect(stdout).not.toContain("skipped (these hook groups were NOT loaded");
  }, TEST_TIMEOUT);

  it("names a `hooks` key that is not an object as a whole layer being out", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ hooks: ["not", "an", "object"] }));
    const { stdout } = await jaa("hooks", "list");

    expect(stdout).toContain("config errors (these layers could not be read, so no hook in them was loaded):");
    expect(stdout).toContain("the `hooks` key is not an object");
  }, TEST_TIMEOUT);

  it("stays silent when every group is valid", async () => {
    const allow = handlerScript(home, "hook-allow", { decision: "allow", reason: "ok" });
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", handlers: [{ kind: "command", command: "node", args: [allow] }] }] } }),
    );
    const { stdout } = await jaa("hooks", "list");

    expect(stdout).not.toContain("skipped");
    expect(stdout).not.toContain("config errors");
    expect(stdout).toContain("matcher: Read");
  }, TEST_TIMEOUT);
});

describe("jaa hooks test surfaces what was dropped before showing a decision", () => {
  it("reports the skipped group and still runs the valid hook it shares a layer with", async () => {
    await writeMixedConfig();
    const { stdout, code } = await jaa("hooks", "test", "PreToolUse", "--tool", "Bash");

    expect(code).toBe(0);
    // The trace is built from the entries that loaded, so a skipped group cannot
    // appear in it. Without this line a `test` run reporting "resolved decision:
    // allow" could be hiding a deny rule that never ran.
    expect(stdout).toContain("skipped:   some configured hooks did NOT load, so they did not run:");
    expect(stdout).toContain("PreToolUse.1.handlers.0.command");
    // The valid sibling did run, and its verdict is a real one.
    expect(stdout).toContain("groups:   2 registered, 1 fired");
    expect(stdout).toContain("decision: deny; reason: a demo deny rule fired on Bash");
    expect(stdout).toContain("resolved decision: deny");
  }, TEST_TIMEOUT);

  it("reports the skip on the other tool too, and the surviving hook still decides", async () => {
    await writeMixedConfig();
    const { stdout } = await jaa("hooks", "test", "PreToolUse", "--tool", "Read");

    expect(stdout).toContain("skipped:   some configured hooks did NOT load, so they did not run:");
    expect(stdout).toContain("decision: allow; reason: a demo allow rule fired on Read");
    expect(stdout).toContain("resolved decision: allow");
  }, TEST_TIMEOUT);

  it("does not claim an event is unregistered when every group for it was skipped", async () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", handlers: [{ kind: "command" }] }] } }),
    );
    const { stdout } = await jaa("hooks", "test", "PreToolUse", "--tool", "Bash");

    expect(stdout).toContain("skipped:   some configured hooks did NOT load, so they did not run:");
    expect(stdout).toContain("groups:   0 registered — every hook for this event was skipped, so none of them fire");
  }, TEST_TIMEOUT);

  it("reports an unreadable layer as unreadable, not as a skipped group", async () => {
    writeFileSync(join(home, "config.json"), "{ nope");
    const { stdout } = await jaa("hooks", "test", "PreToolUse", "--tool", "Bash");

    expect(stdout).toContain("errors:    these layers could not be read, so no hook in them was loaded:");
    expect(stdout).toContain("not valid JSON");
  }, TEST_TIMEOUT);
});

describe("a run that skipped a hook says so on stderr", () => {
  it("warns with a header the detail lines underneath actually support", async () => {
    await writeMixedConfig();
    // `agent run` resolves a provider before it can print a turn, so the model
    // lookup is the first thing that fails on a host with no provider — but the
    // warning is emitted before that, which is exactly where it has to be.
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "## Subagents\n\n### reviewer\n- **Description**: reviews\n- **Instructions**: review\n",
    );
    const { stderr } = await jaa("agent", "run", "reviewer", "check the diff");

    expect(stderr).toContain("jaa: warning: some configured hooks did not run this turn:");
    // The old header claimed a whole layer was dropped, which understates how
    // much of the config still worked and sent operators hunting a missing file.
    expect(stderr).not.toContain("a hook layer was dropped");
    // The detail line already names its own layer, so it must not be prefixed
    // with the settings path a second time.
    expect(stderr).not.toContain(`${join(home, "config.json")}:`);
    expect(stderr).toContain("~/.jaa/config.json: 1 invalid hook entry/entries");
    expect(stderr).toContain("PreToolUse.1.handlers.0.command");
  }, TEST_TIMEOUT);

  it("labels an AGENTS.md warning with AGENTS.md, not with the config path", async () => {
    // The subagent has to exist: an unknown name fails during `loadAgents`, which
    // is before the hook layers are read, so nothing would be reported at all.
    writeFileSync(
      join(workspace, "AGENTS.md"),
      "---\nname: demo\ndescription: demo\nhooks:\n  - PreToolUse\n---\n\n" +
        "## Subagents\n\n### reviewer\n- **Description**: reviews\n- **Instructions**: review\n",
    );
    const { stderr } = await jaa("agent", "run", "reviewer", "check the diff");

    const warning = stderr.split("\n").find((line) => line.includes("AGENTS.md:"));
    expect(warning).toBeDefined();
    // The old code prefixed every warning with the settings path, so an AGENTS.md
    // warning rendered as `<abs>/config.json: AGENTS.md: ...` — one file's path in
    // front of a different file's label.
    expect(warning?.trim().startsWith("AGENTS.md:")).toBe(true);
    expect(stderr).not.toContain(`${join(home, "config.json")}:`);
  }, TEST_TIMEOUT);
});
