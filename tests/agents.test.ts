import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveModelMock } = vi.hoisted(() => ({ resolveModelMock: vi.fn() }));

// `runSubagent` resolves its own model, so the only seam for driving it without a
// provider is the router. Mocked here rather than left to the default settings so
// a developer's real provider config cannot reach a test.
vi.mock("../src/providers/router.js", () => ({ resolveModel: resolveModelMock }));

import { parseAgents, loadAgents, findAgent, getAgentSpec } from "../src/agents/parser.js";
import { buildAgentSystemPrompt, runSubagent } from "../src/agents/runner.js";
import type { AgentSpec } from "../src/agents/types.js";
import type { ChatRequest, ChatResponse, ProviderAdapter, ResolvedModel, ToolCall } from "../src/providers/types.js";
import { parseHookConfigResilient, type ValidatedHookEntry } from "../src/hooks/types.js";
import { createSession } from "../src/agent/session.js";
import { checkpointDir } from "../src/checkpoint/store.js";

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-agents-"));
  // The checkpoint store lives under JAA_HOME, so a test that snapshots must not
  // be allowed to reach the real ~/.jaa.
  process.env.JAA_HOME = join(tmp, "home");
  mkdirSync(process.env.JAA_HOME, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  resolveModelMock.mockReset();
});

const AGENTS_CONTENT = `# AGENTS.md

## Project: jaa — Just An AI

A local-first, multi-provider terminal coding agent.

## Subagents

### code-reviewer
- **Description**: Reviews code for correctness, security, and style
- **Ownership**: \`src/**/*.ts\`, \`tests/**/*.ts\`
- **Deps**: lint, build
- **Acceptance**: \`npm run lint\` exits 0, all tests pass
- **Instructions**: Review the diff for bugs, type-safety violations, and security issues.

### test-writer
- **Description**: Writes and maintains tests
- **Ownership**: \`tests/**/*.ts\`
- **Deps**: code-reviewer
- **Acceptance**: All tests pass
- **Instructions**: Write focused Vitest tests covering edge cases.
`;

describe("parseAgents", () => {
  it("parses project context and subagents from valid content", () => {
    const { projectContext, subagents } = parseAgents(AGENTS_CONTENT);
    expect(projectContext).toContain("## Project: jaa");
    expect(subagents).toHaveLength(2);
    expect(subagents[0]!.name).toBe("code-reviewer");
    expect(subagents[0]!.description).toBe("Reviews code for correctness, security, and style");
    expect(subagents[0]!.ownership).toBe("`src/**/*.ts`, `tests/**/*.ts`");
    expect(subagents[0]!.deps).toBe("lint, build");
    expect(subagents[0]!.acceptance).toBe("`npm run lint` exits 0, all tests pass");
    expect(subagents[0]!.instructions).toBe("Review the diff for bugs, type-safety violations, and security issues.");
    expect(subagents[1]!.name).toBe("test-writer");
  });

  it("returns empty subagents when no ## Subagents section exists", () => {
    const { projectContext, subagents } = parseAgents("# Just a title\nNo subagents here");
    expect(subagents).toEqual([]);
    expect(projectContext).toBe("# Just a title\nNo subagents here");
  });

  it("handles empty subagents section", () => {
    const { subagents } = parseAgents("# Title\n## Subagents\n");
    expect(subagents).toEqual([]);
  });

  it("stops parsing subagents at the next ## section", () => {
    const content = `## Subagents

### agent-a
- **Description**: first
- **Instructions**: do first

## Appendix
This is not a subagent.`;
    const { subagents } = parseAgents(content);
    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.name).toBe("agent-a");
  });

  it("handles Windows line endings", () => {
    const content = "## Subagents\r\n\r\n### test\r\n- **Description**: windows\r\n- **Instructions**: test it\r\n---\nbody";
    const { subagents } = parseAgents(content);
    expect(subagents).toHaveLength(1);
    expect(subagents[0]!.name).toBe("test");
    expect(subagents[0]!.description).toBe("windows");
  });

  it("handles multi-line instructions", () => {
    const content = `## Subagents

### multiline
- **Description**: test
- **Instructions**: First line of instructions
  Second line of instructions
  Third line`;
    const { subagents } = parseAgents(content);
    expect(subagents[0]!.instructions).toContain("First line of instructions");
    expect(subagents[0]!.instructions).toContain("Second line of instructions");
    expect(subagents[0]!.instructions).toContain("Third line");
  });

  it("ignores unknown field names", () => {
    const content = `## Subagents

### test
- **Description**: known
- **UnknownField**: should be ignored
- **Instructions**: ok`;
    const { subagents } = parseAgents(content);
    expect(subagents[0]!.description).toBe("known");
    expect(subagents[0]!.instructions).toBe("ok");
  });

  it("initializes all fields to empty string", () => {
    const content = `## Subagents

### minimal
- **Description**: just this`;
    const { subagents } = parseAgents(content);
    expect(subagents[0]!.name).toBe("minimal");
    expect(subagents[0]!.description).toBe("just this");
    expect(subagents[0]!.ownership).toBe("");
    expect(subagents[0]!.deps).toBe("");
    expect(subagents[0]!.acceptance).toBe("");
    expect(subagents[0]!.instructions).toBe("");
  });
});

describe("loadAgents", () => {
  it("loads AGENTS.md from a specific root", () => {
    writeFileSync(join(tmp, "AGENTS.md"), AGENTS_CONTENT);
    const { subagents } = loadAgents(tmp);
    expect(subagents).toHaveLength(2);
    expect(subagents[0]!.name).toBe("code-reviewer");
  });

  it("returns empty subagents when AGENTS.md does not exist", () => {
    const { projectContext, subagents } = loadAgents(tmp);
    expect(subagents).toEqual([]);
    expect(projectContext).toBe("");
  });
});

describe("findAgent / getAgentSpec", () => {
  it("finds a subagent by name", () => {
    const { subagents } = parseAgents(AGENTS_CONTENT);
    expect(findAgent({ projectContext: "", subagents }, "code-reviewer")?.name).toBe("code-reviewer");
    expect(findAgent({ projectContext: "", subagents }, "test-writer")?.name).toBe("test-writer");
  });

  it("returns undefined for unknown agent name", () => {
    const { subagents } = parseAgents(AGENTS_CONTENT);
    expect(findAgent({ projectContext: "", subagents }, "nonexistent")).toBeUndefined();
  });

  it("getAgentSpec loads from filesystem", () => {
    writeFileSync(join(tmp, "AGENTS.md"), AGENTS_CONTENT);
    expect(getAgentSpec(tmp, "code-reviewer")?.name).toBe("code-reviewer");
    expect(getAgentSpec(tmp, "missing")).toBeUndefined();
  });
});

describe("buildAgentSystemPrompt", () => {
  const spec = {
    name: "code-reviewer",
    description: "Reviews code",
    ownership: "src/**/*.ts",
    deps: "lint",
    acceptance: "tests pass",
    instructions: "Be thorough.",
  };

  it("combines project context, agent name, instructions, and default prompt", () => {
    const prompt = buildAgentSystemPrompt("Project: test app", spec);
    expect(prompt).toContain("## Project context");
    expect(prompt).toContain("Project: test app");
    expect(prompt).toContain("## Subagent: code-reviewer");
    expect(prompt).toContain("Be thorough.");
    expect(prompt).toContain("J.A.A.");
  });

  it("omits project context block when empty", () => {
    const prompt = buildAgentSystemPrompt("", spec);
    expect(prompt).not.toContain("## Project context");
    expect(prompt).toContain("## Subagent: code-reviewer");
    expect(prompt).toContain("Be thorough.");
  });
});

// --- Phase 13 / 14 on the subagent path -------------------------------------
//
// `runSubagent` used to call the loop without `hooks` or `checkpoints`, so
// `jaa agent run` got neither Phase 13 nor Phase 14 while `ask` and `chat` got
// both. These cover the wiring and, just as importantly, that wiring the two in
// grants the subagent nothing it did not already have.

function scriptedAdapter(steps: ChatResponse[]): ProviderAdapter {
  let i = 0;
  return {
    id: "scripted",
    async chat(_req: ChatRequest) {
      const step = steps[i];
      i++;
      if (!step) throw new Error("script exhausted");
      return step;
    },
  };
}

const turn = (calls: ToolCall[]): ChatResponse => ({
  message: { role: "assistant", content: "", toolCalls: calls },
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "script-model",
  provider: "scripted",
});

const done = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "script-model",
  provider: "scripted",
});

/** Point the mocked router at a scripted adapter. */
function useScript(steps: ChatResponse[]): void {
  const model: ResolvedModel = { provider: "scripted", model: "script-model", adapter: scriptedAdapter(steps) };
  resolveModelMock.mockReturnValue(model);
}

const SPEC: AgentSpec = {
  name: "code-reviewer",
  description: "Reviews code",
  ownership: "src/**/*.ts",
  deps: "lint",
  acceptance: "tests pass",
  instructions: "Be thorough.",
};

const PARSED = { projectContext: "Project: test app", subagents: [SPEC] };

/**
 * One `PreToolUse` group with a single `command` handler that prints `payload`
 * on stdout and exits 2 — the shape `jaa hooks test` uses, so the handler really
 * runs rather than being simulated by the chain.
 */
function commandGroup(matcher: string, payload: unknown, dir: string): ValidatedHookEntry[] {
  const script = join(dir, `hook-${matcher}.js`);
  writeFileSync(
    script,
    `process.stdin.resume();\nprocess.stdin.on("end", () => {\n` +
      `  process.stdout.write(${JSON.stringify(JSON.stringify(payload))});\n` +
      `  process.exitCode = 2;\n});\n`,
  );
  const parsed = parseHookConfigResilient({
    PreToolUse: [{ matcher, handlers: [{ kind: "command", command: process.execPath, args: [script] }] }],
  });
  if (parsed.errors.length > 0) throw new Error(`fixture config rejected: ${parsed.errors.join("; ")}`);
  expect(parsed.entries).toHaveLength(1);
  return parsed.entries;
}

/**
 * Three of these spawn a real `node` hook process, which costs more than the
 * 5s default vitest budget allows once the suite runs in parallel.
 */
const SLOW_TEST = 30_000;

/** Records every call that reaches the caller's `executeTool` wrapper. */
function recorder(): { calls: string[]; wrap: (inner: (call: ToolCall) => Promise<string>) => (call: ToolCall) => Promise<string> } {
  const calls: string[] = [];
  return {
    calls,
    wrap:
      (inner) =>
      (call) => {
        calls.push(call.name);
        return inner(call);
      },
  };
}

describe("runSubagent — Phase 13 hooks", () => {
  it("honours a PreToolUse deny: the tool never runs and the model is told why", async () => {
    // Lowercase on purpose: jaa's shell tool is `bash`, and matcher matching is
    // exact, so a matcher written as `Bash` would silently never fire here.
    const entries = commandGroup("bash", { decision: "deny", reason: "policy says no" }, tmp);
    useScript([turn([{ id: "c1", name: "bash", arguments: '{"command":"echo hi"}' }]), done("stopped")]);

    const executed = recorder();
    const result = await runSubagent(PARSED, SPEC, {
      task: "run something",
      cwd: tmp,
      allowBash: true,
      hookEntries: entries,
      hookSessionId: "sub-1",
      // The wrapper `jaa agent run` installs. A deny has to land before this is
      // reached, not inside it.
      executeTool: executed.wrap,
    });

    // Neither the gate wrapper nor the registry was reached.
    expect(executed.calls).toEqual([]);
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("policy says no");
  }, SLOW_TEST);

  it("honours a deny on the subagent path exactly as it does without hooks", async () => {
    // The positive side of the same rule: a group whose matcher names a
    // different tool is not a deny, so the call goes through the caller's gate
    // untouched rather than being blocked by a rule that never applied.
    const entries = commandGroup("write_file", { decision: "deny", reason: "writes are blocked" }, tmp);
    writeFileSync(join(tmp, "AGENTS.md"), "hello");
    useScript([turn([{ id: "c1", name: "read_file", arguments: '{"path":"AGENTS.md"}' }]), done("read it")]);

    const executed = recorder();
    await runSubagent(PARSED, SPEC, {
      task: "read the file",
      cwd: tmp,
      hookEntries: entries,
      executeTool: executed.wrap,
    });

    expect(executed.calls).toEqual(["read_file"]);
  }, SLOW_TEST);

  it("is inert with no hooks: no chain is built and the tool runs", async () => {
    useScript([turn([{ id: "c1", name: "read_file", arguments: '{"path":"AGENTS.md"}' }]), done("done")]);
    writeFileSync(join(tmp, "AGENTS.md"), "hello");

    const executed = recorder();
    const result = await runSubagent(PARSED, SPEC, {
      task: "read the file",
      cwd: tmp,
      executeTool: executed.wrap,
    });

    expect(executed.calls).toEqual(["read_file"]);
    expect(result.stopReason).toBe("completed");
  });

  it("is inert with an empty hook list, which is what a host with no hooks passes", async () => {
    useScript([turn([{ id: "c1", name: "read_file", arguments: '{"path":"AGENTS.md"}' }]), done("done")]);
    writeFileSync(join(tmp, "AGENTS.md"), "hello");

    const executed = recorder();
    await runSubagent(PARSED, SPEC, {
      task: "read the file",
      cwd: tmp,
      hookEntries: [],
      executeTool: executed.wrap,
    });

    expect(executed.calls).toEqual(["read_file"]);
  });
});

describe("runSubagent — Phase 14 checkpoints", () => {
  it("snapshots a file before a mutating call, so the subagent's writes are rewindable", async () => {
    const target = join(tmp, "note.txt");
    writeFileSync(target, "before\n");
    useScript([
      turn([{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "note.txt", content: "after\n" }) }]),
      done("wrote it"),
    ]);

    const s = createSession();
    await runSubagent(PARSED, SPEC, { task: "write note.txt", cwd: tmp, checkpointSession: s });

    const dir = checkpointDir(s);
    expect(existsSync(dir)).toBe(true);
    const snapshots = readdirSync(dir);
    expect(snapshots).toHaveLength(1);
    const stored = JSON.parse(readFileSync(join(dir, snapshots[0]!), "utf8")) as { content: string };
    // The pre-write content, which is the whole point of taking it first.
    expect(stored.content).toBe("before\n");
    expect(readFileSync(target, "utf8")).toBe("after\n");
  });

  it("takes no snapshot at all when no session is named", async () => {
    const target = join(tmp, "note.txt");
    writeFileSync(target, "before\n");
    useScript([
      turn([{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "note.txt", content: "after\n" }) }]),
      done("wrote it"),
    ]);

    await runSubagent(PARSED, SPEC, { task: "write note.txt", cwd: tmp });

    // Nothing to name a store with, so nothing is written anywhere under the root.
    expect(existsSync(join(process.env.JAA_HOME!, "checkpoints"))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("after\n");
  });

  it("snapshots nothing for a shell call, which has no single file target", async () => {
    useScript([turn([{ id: "c1", name: "bash", arguments: '{"command":"echo hi"}' }]), done("ran it")]);

    const s = createSession();
    await runSubagent(PARSED, SPEC, { task: "say hi", cwd: tmp, allowBash: true, checkpointSession: s });

    // `bash` declares no `path`, so there is nothing to read before it runs. A
    // snapshot taken here would mean a file the shell never touched could be
    // written back by a later rewind.
    expect(existsSync(checkpointDir(s))).toBe(false);
  });

  it("does not snapshot outside the workspace root", async () => {
    useScript([
      turn([{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "../escape.txt", content: "x" }) }]),
      done("tried"),
    ]);

    const s = createSession();
    const result = await runSubagent(PARSED, SPEC, { task: "escape", cwd: tmp, checkpointSession: s });

    expect(existsSync(join(tmp, "..", "escape.txt"))).toBe(false);
    // Whatever the tool reported, no snapshot of a file outside the root exists.
    expect(existsSync(checkpointDir(s))).toBe(false);
    expect(result.stopReason).toBe("completed");
  });

  it("does not snapshot a call a PreToolUse hook denied", async () => {
    const entries = commandGroup("bash", { decision: "deny", reason: "policy says no" }, tmp);
    const target = join(tmp, "note.txt");
    writeFileSync(target, "before\n");
    useScript([turn([{ id: "c1", name: "bash", arguments: '{"command":"echo hi"}' }]), done("stopped")]);

    const s = createSession();
    await runSubagent(PARSED, SPEC, {
      task: "do it",
      cwd: tmp,
      allowBash: true,
      checkpointSession: s,
      hookEntries: entries,
    });

    expect(existsSync(checkpointDir(s))).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("before\n");
  }, SLOW_TEST);
});
