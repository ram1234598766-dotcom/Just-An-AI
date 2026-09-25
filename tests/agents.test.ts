import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAgents, loadAgents, findAgent, getAgentSpec } from "../src/agents/parser.js";
import { buildAgentSystemPrompt } from "../src/agents/runner.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-agents-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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
