import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, resolveModelMock, runSubagentMock, loadAgentsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolveModelMock: vi.fn(),
  runSubagentMock: vi.fn(),
  loadAgentsMock: vi.fn(),
}));

vi.mock("../src/providers/router.js", () => ({ resolveModel: resolveModelMock }));
vi.mock("../src/agents/runner.js", () => ({ runSubagent: runSubagentMock }));
vi.mock("../src/agents/index.js", () => ({ loadAgents: loadAgentsMock }));

import { McpClient } from "../src/mcp/client.js";
import type { McpToolCallResult } from "../src/mcp/types.js";
import { isRecord } from "../src/mcp/validation.js";
import type { ChatRequest, ChatResponse, ProviderAdapter } from "../src/providers/types.js";
import { BLOCKING_EVENTS, HOOK_EVENTS } from "../src/hooks/events.js";
import type { HookEvent } from "../src/hooks/events.js";
import { ifFilterApplies, matcherField, matcherMatches, parseMatcher } from "../src/hooks/matcher.js";
import { applyHookGroupResult, decideFromHooks, fireHookGroups } from "../src/hooks/decide.js";
import { buildPayload, clampHookOutput, runHookHandler } from "../src/hooks/run.js";
import {
  defaultHookPaths,
  loadAgentsHooks,
  loadAllHooks,
  loadClaudeSettingsHooks,
  loadSettingsHooks,
} from "../src/hooks/load.js";
import { MAX_HOOK_OUTPUT, parseHookConfig, parseHookConfigResilient } from "../src/hooks/types.js";
import type {
  HookDecision,
  HookDecisionOutput,
  HookGroup,
  HookHandler,
  HookPayload,
  HookTimeouts,
  ValidatedHookEntry,
} from "../src/hooks/types.js";

/** Short deadlines, so a hung fake cannot hold the suite open. */
const FAST: HookTimeouts = { commandMs: 10_000, httpMs: 1_000, promptMs: 500, agentMs: 500, mcpMs: 500 };
const POST_EVENTS: readonly HookEvent[] = ["PostToolUse", "PostToolUseFailure"];
const NODE = process.execPath;
const FAKE_SERVER = "guard";

let tmp: string;
let workspace: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-hooks-"));
  workspace = join(tmp, "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.JAA_HOME = tmp;
  // `runHttpHook` calls the platform's global fetch, so the seam is the global
  // rather than an http library module.
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  resolveModelMock.mockReset();
  runSubagentMock.mockReset();
  loadAgentsMock.mockReset();
  loadAgentsMock.mockReturnValue({ projectContext: "", subagents: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

function decode(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error(`expected a JSON object, got: ${value}`);
  return parsed;
}

class FakeMcpClient extends McpClient {
  private readonly respond: (tool: string, argsJson: string) => Promise<McpToolCallResult>;

  constructor(respond: (tool: string, argsJson: string) => Promise<McpToolCallResult>) {
    super("jaa-fake-mcp-server");
    this.respond = respond;
  }

  override hasTool(_name: string): boolean {
    return true;
  }

  override callTool(tool: string, argsJson: string): Promise<McpToolCallResult> {
    return this.respond(tool, argsJson);
  }
}

function mcpHook(over: { tool?: string; input?: Record<string, unknown>; timeoutMs?: number } = {}): HookHandler {
  return {
    kind: "mcp",
    server: FAKE_SERVER,
    tool: over.tool ?? "check",
    ...(over.input !== undefined ? { input: over.input } : {}),
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}),
  };
}

/** An MCP client that answers every call with `out` as the hook decision. */
function decidingClient(out: HookDecisionOutput): McpClient {
  return new FakeMcpClient(async () => ({ content: [{ type: "text", text: JSON.stringify(out) }] }));
}

/** An MCP client that records every argument payload it is handed. */
function recordingClient(record: string[]): McpClient {
  return new FakeMcpClient(async (_tool, argsJson) => {
    record.push(argsJson);
    return { content: [{ type: "text", text: JSON.stringify({ systemMessage: "seen" }) }] };
  });
}

/**
 * An MCP client that hands out `outcomes` one per call, in call order.
 *
 * Handlers in a group start in declaration order, so a scripted client is how a
 * test gives the first handler one verdict and the second another.
 */
function scriptedClient(outcomes: readonly HookDecisionOutput[]): McpClient {
  let call = 0;
  return new FakeMcpClient(async () => ({
    content: [{ type: "text", text: JSON.stringify(outcomes[call++] ?? {}) }],
  }));
}

function bashPayload(over: Partial<HookPayload> = {}): HookPayload {
  return buildPayload("PreToolUse", {
    sessionId: "s1",
    cwd: "/ws",
    toolName: "Bash",
    toolInput: { command: "rm -rf build" },
    ...over,
  });
}

function oneGroup(handlers: HookHandler[], over: { matcher?: string; if?: string } = {}): HookGroup[] {
  return [
    {
      ...(over.matcher !== undefined ? { matcher: over.matcher } : {}),
      ...(over.if !== undefined ? { if: over.if } : {}),
      handlers,
    },
  ];
}

/**
 * `node -e` hook: read the payload on stdin, then write `body` and exit `code`.
 *
 * `process.exitCode` rather than `process.exit()` so Node flushes stdout before
 * the process ends — a pipe write followed by an immediate exit can truncate.
 */
function commandHook(body: string, code: number, timeoutMs?: number): HookHandler {
  const script = `let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(body)});process.exitCode=${code}});`;
  return {
    kind: "command",
    command: NODE,
    args: ["-e", script],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** `node -e` hook reporting the tool name it read off stdin as its reason. */
function commandEchoHook(): HookHandler {
  const script = `let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{process.stdout.write(JSON.stringify({decision:"allow",reason:JSON.parse(s).toolName}))});`;
  return { kind: "command", command: NODE, args: ["-e", script] };
}

function hangingCommandHook(timeoutMs: number): HookHandler {
  return {
    kind: "command",
    command: NODE,
    args: ["-e", `process.stdin.resume();setInterval(()=>{},20)`],
    timeoutMs,
  };
}

/**
 * A `node -e` hook that writes `chars` characters of stdout.
 *
 * The output is generated rather than embedded in the script, because an
 * oversized literal would exceed the Windows command-line limit and the hook
 * would fail to start instead of flooding.
 */
function floodingCommandHook(chars: number, code = 0): HookHandler {
  const script = `let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{process.stdout.write("c".repeat(${chars}));process.exitCode=${code}});`;
  return { kind: "command", command: NODE, args: ["-e", script] };
}

const MISSING_BINARY: HookHandler = { kind: "command", command: "jaa-no-such-hook-binary-9f3a", args: ["--check"] };

function answeringAdapter(content: string): ProviderAdapter {
  return {
    id: "fake",
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      message: { role: "assistant", content },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake-1",
      provider: "fake",
    }),
  };
}

function rejectingAdapter(message: string): ProviderAdapter {
  return { id: "fake", chat: () => Promise.reject(new Error(message)) };
}

const HANGING_ADAPTER: ProviderAdapter = {
  id: "fake",
  chat: () => new Promise<ChatResponse>(() => {}),
};

function useModel(adapter: ProviderAdapter): void {
  resolveModelMock.mockReturnValue({ provider: "fake", model: "fake-1", adapter });
}

function useAgentVerdict(content: string): void {
  runSubagentMock.mockResolvedValue({
    spec: { name: "hook-agent", description: "Hook agent", ownership: "*", deps: "none", acceptance: "none", instructions: "judge" },
    messages: [{ role: "assistant", content }],
    stopReason: "end",
    turns: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
  });
}

function useHttpResponse(body: string, ok = true): void {
  fetchMock.mockResolvedValue({ ok, text: () => Promise.resolve(body) });
}

/**
 * An http hook response whose body arrives as a stream, the way a real
 * `fetch` response does — as opposed to the buffered `{ ok, text }` double.
 */
function useHttpStream(chunks: readonly string[], ok = true): void {
  const encoder = new TextEncoder();
  fetchMock.mockResolvedValue({
    ok,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  });
}

function groupCount(entries: ValidatedHookEntry[], event: HookEvent): number {
  return entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups).length;
}

function loadedEvents(entries: ValidatedHookEntry[]): HookEvent[] {
  return entries.map((entry) => entry.event);
}

describe("buildPayload", () => {
  it("rejects an event name outside the vocabulary", () => {
    expect(() => buildPayload("NotAnEvent")).toThrow(/unknown hook event/);
  });

  it("defaults a SessionStart payload to the startup source and honours an explicit one", () => {
    expect(buildPayload("SessionStart").startupSource).toBe("startup");
    expect(buildPayload("SessionStart", { startupSource: "resume" }).startupSource).toBe("resume");
    expect(buildPayload("SessionStart", { startupSource: "clear" }).startupSource).toBe("clear");
  });

  it("omits the startup source for every other event", () => {
    expect("startupSource" in buildPayload("Stop")).toBe(false);
    expect("startupSource" in buildPayload("PreToolUse", { toolName: "Bash" })).toBe(false);
  });

  it("always carries the common fields and passes tool fields through", () => {
    const payload = buildPayload("PreToolUse", {
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolCallId: "call-1",
      permissionMode: "default",
    });
    expect(payload.hookEventName).toBe("PreToolUse");
    expect(payload.sessionId).toBe("unknown");
    expect(payload.toolName).toBe("Bash");
    expect(payload.toolInput).toEqual({ command: "ls" });
    expect(payload.toolCallId).toBe("call-1");
    expect(payload.permissionMode).toBe("default");
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
  });
});

describe("SessionStart matchers", () => {
  it("fires a non-wildcard SessionStart matcher written as the startup source", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks(
      "SessionStart",
      oneGroup([mcpHook()], { matcher: "startup" }),
      buildPayload("SessionStart"),
      FAST,
      [recordingClient(record)],
    );
    expect(chain.groups.map((g) => g.fired)).toEqual([true]);
    expect(record).toHaveLength(1);
    expect(decode(record[0] ?? "{}")["startupSource"]).toBe("startup");
  });

  it("does not fire a startup matcher for a resumed session", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks(
      "SessionStart",
      oneGroup([mcpHook()], { matcher: "startup" }),
      buildPayload("SessionStart", { startupSource: "resume" }),
      FAST,
      [recordingClient(record)],
    );
    expect(chain.groups.map((g) => g.fired)).toEqual([false]);
    expect(chain.groups[0]?.handlers).toEqual([]);
    expect(record).toEqual([]);
  });

  it("fires the matcher that names the source the payload actually carries", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks(
      "SessionStart",
      oneGroup([mcpHook()], { matcher: "resume" }),
      buildPayload("SessionStart", { startupSource: "resume" }),
      FAST,
      [recordingClient(record)],
    );
    expect(chain.groups.map((g) => g.fired)).toEqual([true]);
    expect(record).toHaveLength(1);
  });
});

describe("event routing", () => {
  function fixtureFor(event: HookEvent): { matcher?: string; payload: HookPayload } {
    const field = matcherField(event);
    if (field === "toolName") {
      return { matcher: "Bash", payload: buildPayload(event, { toolName: "Bash", toolInput: { command: "ls" } }) };
    }
    if (field === "agentType") {
      return { matcher: "reviewer", payload: buildPayload(event, { agentType: "reviewer" }) };
    }
    if (field === "startupSource") {
      return { matcher: "startup", payload: buildPayload(event) };
    }
    return { payload: buildPayload(event) };
  }

  it("fires and routes all 16 events, each with the matcher its own field needs", async () => {
    expect(HOOK_EVENTS).toHaveLength(16);
    for (const event of HOOK_EVENTS) {
      const fixture = fixtureFor(event);
      const parsed = parseHookConfig({
        [event]: [
          {
            ...(fixture.matcher !== undefined ? { matcher: fixture.matcher } : {}),
            handlers: [{ kind: "mcp", server: FAKE_SERVER, tool: "check" }],
          },
        ],
      });
      expect(parsed.ok, event).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.entries.map((entry) => entry.event), event).toEqual([event]);

      const record: string[] = [];
      const chain = await decideFromHooks(event, parsed.entries.flatMap((entry) => entry.groups), fixture.payload, FAST, [
        recordingClient(record),
      ]);
      expect(chain.groups.map((g) => g.fired), event).toEqual([true]);
      expect(record, event).toHaveLength(1);
      expect(decode(record[0] ?? "{}")["hookEventName"], event).toBe(event);
    }
  });

  it("keeps a matched and an unmatched group distinguishable in one chain", async () => {
    const record: string[] = [];
    const groups: HookGroup[] = [
      { matcher: "Bash", handlers: [mcpHook()] },
      { matcher: "Read", handlers: [mcpHook()] },
    ];
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [recordingClient(record)]);
    expect(chain.groups.map((g) => g.fired)).toEqual([true, false]);
    expect(record).toHaveLength(1);
  });

  it("applies nothing from a group that never fired", () => {
    const applied = applyHookGroupResult({ matcher: "Read", fired: false, handlers: [] }, bashPayload());
    expect(applied).toEqual({ ok: true });
  });

  it("reports the matcher it used for every group, defaulting to the wildcard", async () => {
    const results = await fireHookGroups("Stop", [{ handlers: [mcpHook()] }], buildPayload("Stop"), FAST, [decidingClient({})]);
    expect(results[0]?.matcher).toBe("*");
    expect(results[0]?.fired).toBe(true);
  });
});

describe("handler kinds", () => {
  it("runs a command hook and applies the decision it printed on exit 2", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([commandHook(JSON.stringify({ decision: "deny", reason: "blocked by policy" }), 2)], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("blocked by policy");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(true);
  });

  it("lets a command hook see the payload it is judging", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([commandEchoHook()], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("allow");
    expect(chain.reason).toBe("Bash");
  });

  it("runs an http hook, POSTing the payload and reading the decision from the body", async () => {
    useHttpResponse(JSON.stringify({ decision: "deny", reason: "policy service refused" }));
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([{ kind: "http", url: "https://guard.invalid/check", headers: { "x-jaa": "1" } }], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("policy service refused");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://guard.invalid/check",
      expect.objectContaining({ method: "POST", headers: { "x-jaa": "1" }, body: expect.stringContaining("Bash") }),
    );
  });

  it("ignores a non-JSON http body instead of guessing a decision", async () => {
    useHttpResponse("<html>nope</html>");
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "http", url: "https://guard.invalid/check" }]), bashPayload(), FAST);
    expect(chain.decision).toBeUndefined();
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(true);
  });

  it("runs a prompt hook and reads the verdict from the model's reply", async () => {
    useModel(answeringAdapter(JSON.stringify({ decision: "deny", reason: "the model says no" })));
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([{ kind: "prompt", prompt: "Judge this tool call" }], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("the model says no");
    expect(resolveModelMock).toHaveBeenCalled();
  });

  it("runs an mcp hook, merging the handler input into the payload it sends", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook({ tool: "policy", input: { ruleset: "strict" } })], { matcher: "Bash" }),
      bashPayload(),
      FAST,
      [recordingClient(record)],
    );
    expect(chain.systemMessage).toBe("seen");
    expect(decode(record[0] ?? "{}")).toMatchObject({ hookEventName: "PreToolUse", toolName: "Bash", ruleset: "strict" });
  });

  it("runs an agent hook with the configured prompt as the subagent instructions", async () => {
    useModel(answeringAdapter("unused"));
    useAgentVerdict(JSON.stringify({ decision: "allow", reason: "clean" }));
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([{ kind: "agent", prompt: "Is this safe?" }], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("allow");
    expect(chain.reason).toBe("clean");
    const [agents, spec] = runSubagentMock.mock.calls[0] ?? [];
    expect(agents).toEqual({ projectContext: "", subagents: [] });
    expect(isRecord(spec) ? spec["instructions"] : undefined).toBe("Is this safe?");
  });

  it("drives all five kinds through the same single-handler entry point", async () => {
    useHttpResponse(JSON.stringify({ decision: "allow" }));
    useModel(answeringAdapter(JSON.stringify({ decision: "allow" })));
    useAgentVerdict(JSON.stringify({ decision: "allow" }));
    const kinds: HookHandler[] = [
      commandHook(JSON.stringify({ decision: "allow" }), 0),
      { kind: "http", url: "https://guard.invalid/check" },
      { kind: "prompt", prompt: "allow?" },
      mcpHook(),
      { kind: "agent", prompt: "allow?" },
    ];
    expect(kinds.map((handler) => handler.kind)).toEqual(["command", "http", "prompt", "mcp", "agent"]);
    for (const handler of kinds) {
      const result = await runHookHandler(handler, bashPayload(), FAST, [decidingClient({ decision: "allow" })]);
      expect(result.ok, handler.kind).toBe(true);
      expect(result.decision?.decision, handler.kind).toBe("allow");
      expect(result.durationMs, handler.kind).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("blocking decisions", () => {
  it("treats exactly PreToolUse and PermissionRequest as blocking", () => {
    expect([...BLOCKING_EVENTS].sort()).toEqual(["PermissionRequest", "PreToolUse"]);
  });

  it("resolves allow and deny from both blocking events", async () => {
    for (const event of BLOCKING_EVENTS) {
      const resolved: (HookDecision | "none")[] = [];
      for (const decision of ["allow", "deny"] as const) {
        const chain = await decideFromHooks(
          event,
          oneGroup([mcpHook()], { matcher: "Bash" }),
          buildPayload(event, { toolName: "Bash", toolInput: { command: "ls" } }),
          FAST,
          [decidingClient({ decision })],
        );
        expect(chain.decision, `${event} ${decision}`).toBe(decision);
        resolved.push(chain.decision ?? "none");
      }
      expect(resolved, event).toEqual(["allow", "deny"]);
    }
  });

  it("carries an ask verdict on both the group result and the chain decision", async () => {
    for (const event of BLOCKING_EVENTS) {
      const chain = await decideFromHooks(
        event,
        oneGroup([mcpHook()], { matcher: "Bash" }),
        buildPayload(event, { toolName: "Bash" }),
        FAST,
        [decidingClient({ decision: "ask", reason: "confirm with the operator" })],
      );
      expect(chain.groups[0]?.decision, event).toBe("ask");
      expect(chain.decision, event).toBe("ask");
      expect(chain.reason, event).toBe("confirm with the operator");
    }
  });

  it("returns no decision when a blocking hook stays silent", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook()]), bashPayload(), FAST, [decidingClient({})]);
    expect(chain.decision).toBeUndefined();
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(true);
  });

  it("rewrites the tool arguments on PreToolUse via updatedInput", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook()], { matcher: "Bash" }),
      bashPayload(),
      FAST,
      [decidingClient({ updatedInput: { command: "rm -rf build --dry-run" } })],
    );
    expect(chain.updatedInput).toEqual({ command: "rm -rf build --dry-run" });
    expect(chain.decision).toBeUndefined();
  });

  it("keeps a rewrite that arrived alongside a decision, on the chain as well as the group", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook()], { matcher: "Bash" }),
      bashPayload(),
      FAST,
      [decidingClient({ decision: "allow", updatedInput: { command: "ls" } })],
    );
    expect(chain.decision).toBe("allow");
    expect(chain.groups[0]?.updatedInput).toEqual({ command: "ls" });
    expect(chain.updatedInput).toEqual({ command: "ls" });
  });

  it("applies an argument rewrite with the context that came with it", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook()], { matcher: "Bash" }),
      bashPayload(),
      FAST,
      [decidingClient({ updatedInput: { command: "ls" }, additionalContext: "rewritten by policy" })],
    );
    expect(chain.decision).toBeUndefined();
    expect(chain.updatedInput).toEqual({ command: "ls" });
    expect(chain.additionalContext).toBe("rewritten by policy");
  });

  it("rewrites the tool result on PostToolUse without blocking anything", async () => {
    const payload = buildPayload("PostToolUse", { toolName: "Bash", toolResponse: "original" });
    const chain = await decideFromHooks(
      "PostToolUse",
      oneGroup([mcpHook()], { matcher: "Bash" }),
      payload,
      FAST,
      [decidingClient({ additionalContext: "redacted", systemMessage: "output trimmed" })],
    );
    expect(chain.additionalContext).toBe("redacted");
    expect(chain.systemMessage).toBe("output trimmed");
    expect(payload.toolResponse).toBe("original");
  });
});

describe("fail closed on a blocking event", () => {
  it("denies a command that cannot be spawned", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([MISSING_BINARY], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toContain("Bash");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
  });

  it("denies a command that exits non-zero without a verdict", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([commandHook("", 1)], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toContain("command");
  });

  it("denies a blocking command that exits 2 but prints no parseable decision", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([commandHook("not json at all", 2)], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
  });

  it("denies a command that outlives its timeout", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([hangingCommandHook(150)], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
  });

  it("denies an http hook that answers 500", async () => {
    useHttpResponse("server exploded", false);
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "http", url: "https://guard.invalid/check" }], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
  });

  it("denies an http hook whose request throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "http", url: "https://guard.invalid/check" }], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("ECONNREFUSED");
  });

  it("denies a prompt hook whose model call throws", async () => {
    useModel(rejectingAdapter("no key configured"));
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "prompt", prompt: "judge" }], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("no key configured");
  });

  it("denies a prompt hook whose model call hangs past its timeout", async () => {
    useModel(HANGING_ADAPTER);
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([{ kind: "prompt", prompt: "judge", timeoutMs: 150 }], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("timed out");
  });

  it("denies an agent hook whose subagent throws", async () => {
    useModel(answeringAdapter("unused"));
    runSubagentMock.mockRejectedValue(new Error("subagent crashed"));
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "agent", prompt: "judge" }], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("subagent crashed");
  });

  it("denies an agent hook whose subagent hangs past its timeout", async () => {
    useModel(answeringAdapter("unused"));
    runSubagentMock.mockImplementation(() => new Promise(() => {}));
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([{ kind: "agent", prompt: "judge", timeoutMs: 150 }], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
  });

  it("denies an mcp hook whose server is not connected", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook()], { matcher: "Bash" }), bashPayload(), FAST, []);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("not connected");
  });

  it("denies an mcp hook whose tool call throws", async () => {
    const client = new FakeMcpClient(() => Promise.reject(new Error("tool blew up")));
    const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook()], { matcher: "Bash" }), bashPayload(), FAST, [client]);
    expect(chain.decision).toBe("deny");
  });

  it("denies an mcp hook whose tool call hangs past its timeout", async () => {
    const client = new FakeMcpClient(() => new Promise<McpToolCallResult>(() => {}));
    const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook({ timeoutMs: 150 })], { matcher: "Bash" }), bashPayload(), FAST, [client]);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
    expect(chain.groups[0]?.handlers[0]?.stdout).toContain("timed out");
  });

  it("never resolves a failing blocking handler to allow, for any kind", async () => {
    const failing: { label: string; prepare: () => void; handler: HookHandler; clients: McpClient[] }[] = [
      { label: "command/ENOENT", prepare: () => {}, handler: MISSING_BINARY, clients: [] },
      { label: "command/exit-1", prepare: () => {}, handler: commandHook("", 1), clients: [] },
      { label: "command/exit-2-garbage", prepare: () => {}, handler: commandHook("}{", 2), clients: [] },
      { label: "command/timeout", prepare: () => {}, handler: hangingCommandHook(120), clients: [] },
      {
        label: "http/500",
        prepare: () => useHttpResponse("server exploded", false),
        handler: { kind: "http", url: "https://guard.invalid/check" },
        clients: [],
      },
      {
        label: "http/throw",
        prepare: () => fetchMock.mockRejectedValue(new Error("ECONNREFUSED")),
        handler: { kind: "http", url: "https://guard.invalid/check" },
        clients: [],
      },
      {
        label: "prompt/throw",
        prepare: () => useModel(rejectingAdapter("no key configured")),
        handler: { kind: "prompt", prompt: "judge" },
        clients: [],
      },
      {
        label: "prompt/timeout",
        prepare: () => useModel(HANGING_ADAPTER),
        handler: { kind: "prompt", prompt: "judge", timeoutMs: 120 },
        clients: [],
      },
      {
        label: "agent/throw",
        prepare: () => {
          useModel(answeringAdapter("unused"));
          runSubagentMock.mockRejectedValueOnce(new Error("subagent crashed"));
        },
        handler: { kind: "agent", prompt: "judge" },
        clients: [],
      },
      {
        label: "agent/timeout",
        prepare: () => {
          useModel(answeringAdapter("unused"));
          runSubagentMock.mockImplementationOnce(() => new Promise(() => {}));
        },
        handler: { kind: "agent", prompt: "judge", timeoutMs: 120 },
        clients: [],
      },
      { label: "mcp/not-connected", prepare: () => {}, handler: mcpHook(), clients: [] },
      {
        label: "mcp/throw",
        prepare: () => {},
        handler: mcpHook(),
        clients: [new FakeMcpClient(() => Promise.reject(new Error("tool blew up")))],
      },
      {
        label: "mcp/timeout",
        prepare: () => {},
        handler: mcpHook({ timeoutMs: 120 }),
        clients: [new FakeMcpClient(() => new Promise<McpToolCallResult>(() => {}))],
      },
    ];
    for (const failure of failing) {
      failure.prepare();
      const chain = await decideFromHooks("PreToolUse", oneGroup([failure.handler], { matcher: "Bash" }), bashPayload(), FAST, failure.clients);
      expect(chain.decision, failure.label).toBe("deny");
      expect(chain.groups[0]?.handlers[0]?.ok, failure.label).toBe(false);
    }
  });

  it("falls back to passthrough on a post event, so a crash cannot invent a block", async () => {
    for (const event of POST_EVENTS) {
      const chain = await decideFromHooks(event, oneGroup([MISSING_BINARY], { matcher: "Bash" }), buildPayload(event, { toolName: "Bash" }), FAST);
      expect(chain.decision, event).toBeUndefined();
      expect(chain.groups[0]?.handlers[0]?.ok, event).toBe(false);
    }
  });

  it("lets a non-blocking event's failure pass through untouched", async () => {
    const chain = await decideFromHooks("SessionEnd", oneGroup([MISSING_BINARY]), buildPayload("SessionEnd"), FAST);
    expect(chain.decision).toBeUndefined();
  });

  it("denies a blocking group whose crashed sibling allowed, in either order", async () => {
    // The failing handler returned no verdict, so the sibling's `allow` used to
    // be the group's whole decision. The spec is explicit that a crash on a
    // pre-use event must resolve to deny, never to allow, so it outranks
    // whatever its siblings voted.
    const orders: { label: string; handlers: HookHandler[]; oks: boolean[] }[] = [
      { label: "crash,allow", handlers: [MISSING_BINARY, mcpHook()], oks: [false, true] },
      { label: "allow,crash", handlers: [mcpHook(), MISSING_BINARY], oks: [true, false] },
    ];
    for (const { label, handlers, oks } of orders) {
      const chain = await decideFromHooks("PreToolUse", oneGroup(handlers, { matcher: "Bash" }), bashPayload(), FAST, [
        decidingClient({ decision: "allow", reason: "looks fine" }),
      ]);
      expect(chain.groups[0]?.handlers.map((h) => h.ok), label).toEqual(oks);
      expect(chain.decision, label).toBe("deny");
      expect(chain.reason, label).toContain("hook failed");
      // The trace shows the same verdict the chain reached, not the allow.
      expect(chain.groups[0]?.decision, label).toBe("deny");
    }
  });

  it("denies a blocking group whose timed-out sibling allowed", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([hangingCommandHook(120), mcpHook()], { matcher: "Bash" }), bashPayload(), FAST, [
      decidingClient({ decision: "allow" }),
    ]);
    // Whether the deadline is reached by the handler's own timer or by the spawn
    // timeout, the observable shape is the same: a handler that produced no
    // verdict, next to a sibling that did.
    expect(chain.groups[0]?.handlers.map((h) => h.ok)).toEqual([false, true]);
    expect(chain.decision).toBe("deny");
  });

  it("denies both blocking events when a crash shares a group with an allow", async () => {
    for (const event of BLOCKING_EVENTS) {
      const chain = await decideFromHooks(event, oneGroup([MISSING_BINARY, mcpHook()]), buildPayload(event, { toolName: "Bash" }), FAST, [
        decidingClient({ decision: "allow" }),
      ]);
      expect(chain.decision, event).toBe("deny");
    }
  });

  it("still passes a post event through when a crash shares a group with an allow", async () => {
    // The same crash that denies pre-use must not invent a block after the tool
    // has run: the surviving sibling's verdict stands and nothing is denied.
    for (const event of POST_EVENTS) {
      const chain = await decideFromHooks(event, oneGroup([MISSING_BINARY, mcpHook()]), buildPayload(event, { toolName: "Bash" }), FAST, [
        decidingClient({ decision: "allow" }),
      ]);
      expect(chain.groups[0]?.handlers.map((h) => h.ok), event).toEqual([false, true]);
      expect(chain.decision, event).not.toBe("deny");
      expect(chain.decision, event).toBe("allow");
    }
  });
});

describe("deny precedence", () => {
  it("denies when any group in the event denies", async () => {
    const groups: HookGroup[] = [
      { matcher: "Bash", handlers: [mcpHook()] },
      { matcher: "Bash", handlers: [mcpHook()] },
    ];
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [decidingClient({ decision: "deny", reason: "no" })]);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("no");
    expect(chain.groups).toHaveLength(2);
  });

  it("keeps the deny when the following group would allow", async () => {
    const groups: HookGroup[] = [
      { matcher: "Bash", handlers: [mcpHook()] },
      { matcher: "Bash", handlers: [mcpHook()] },
    ];
    const responses: HookDecisionOutput[] = [{ decision: "deny" }, { decision: "allow" }];
    let call = 0;
    const client = new FakeMcpClient(async () => ({
      content: [{ type: "text", text: JSON.stringify(responses[call++] ?? {}) }],
    }));
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [client]);
    expect(chain.groups).toHaveLength(2);
    expect(chain.decision).toBe("deny");
  });

  it("takes the first blocking decision inside a single group", async () => {
    const denied = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook(), mcpHook()]),
      bashPayload(),
      FAST,
      [decidingClient({ decision: "deny", reason: "no" })],
    );
    expect(denied.decision).toBe("deny");

    const allowed = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook(), mcpHook()]),
      bashPayload(),
      FAST,
      [decidingClient({ decision: "allow" })],
    );
    expect(allowed.decision).toBe("allow");
  });

  it("lets a deny win over an allow in the same group, whichever order they are declared in", async () => {
    const orders: HookDecisionOutput[][] = [
      [{ decision: "allow", reason: "looks fine" }, { decision: "deny", reason: "not fine" }],
      [{ decision: "deny", reason: "not fine" }, { decision: "allow", reason: "looks fine" }],
    ];
    for (const outcomes of orders) {
      const label = outcomes.map((o) => o.decision).join(",");
      const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook(), mcpHook()]), bashPayload(), FAST, [scriptedClient(outcomes)]);
      expect(chain.decision, label).toBe("deny");
      expect(chain.reason, label).toBe("not fine");
      // The verdicts the handlers actually returned stay in the trace, in
      // declaration order, so the ordering behind the decision is inspectable.
      expect(chain.groups[0]?.handlers.map((h) => h.decision?.decision), label).toEqual(outcomes.map((o) => o.decision));
      expect(chain.groups[0]?.decision, label).toBe("deny");
    }
  });

  it("ranks a group's verdicts deny, then ask, then allow, in either order", async () => {
    const cases: { outcomes: HookDecisionOutput[]; expected: HookDecision }[] = [
      { outcomes: [{ decision: "ask" }, { decision: "allow" }], expected: "ask" },
      { outcomes: [{ decision: "allow" }, { decision: "ask" }], expected: "ask" },
      { outcomes: [{ decision: "ask" }, { decision: "deny" }], expected: "deny" },
      { outcomes: [{ decision: "deny" }, { decision: "ask" }], expected: "deny" },
      { outcomes: [{ decision: "allow" }, { decision: "ask" }, { decision: "deny" }], expected: "deny" },
    ];
    for (const { outcomes, expected } of cases) {
      const label = outcomes.map((o) => o.decision).join(",");
      const chain = await decideFromHooks(
        "PreToolUse",
        oneGroup([mcpHook(), mcpHook(), mcpHook()].slice(0, outcomes.length)),
        bashPayload(),
        FAST,
        [scriptedClient(outcomes)],
      );
      expect(chain.decision, label).toBe(expected);
    }
  });

  it("keeps a rewrite from one handler while a different handler's decision wins", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([mcpHook(), mcpHook()], { matcher: "Bash" }),
      bashPayload(),
      FAST,
      [scriptedClient([{ updatedInput: { command: "ls" }, additionalContext: "narrowed" }, { decision: "deny", reason: "not fine" }])],
    );
    expect(chain.decision).toBe("deny");
    expect(chain.updatedInput).toEqual({ command: "ls" });
    expect(chain.additionalContext).toBe("narrowed");
  });

  it("lets a failure in a later group override an earlier allow", async () => {
    const groups: HookGroup[] = [
      { matcher: "Bash", handlers: [mcpHook()] },
      { matcher: "Bash", handlers: [MISSING_BINARY] },
    ];
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [decidingClient({ decision: "allow" })]);
    expect(chain.decision).toBe("deny");
  });

  it("ranks groups deny, then ask, then allow, in either order", async () => {
    // The within-group ranking has to hold one level up too, or a chain of
    // [allow, ask] would resolve to allow and the operator would never be
    // asked about the call a group flagged for confirmation.
    const cases: { outcomes: HookDecisionOutput[]; expected: HookDecision; reason: string }[] = [
      { outcomes: [{ decision: "allow", reason: "first allows" }, { decision: "ask", reason: "second asks" }], expected: "ask", reason: "second asks" },
      { outcomes: [{ decision: "ask", reason: "first asks" }, { decision: "allow", reason: "second allows" }], expected: "ask", reason: "first asks" },
      { outcomes: [{ decision: "allow", reason: "a1" }, { decision: "ask", reason: "a2" }, { decision: "allow", reason: "a3" }], expected: "ask", reason: "a2" },
      { outcomes: [{ decision: "deny", reason: "no" }, { decision: "ask", reason: "asks" }], expected: "deny", reason: "no" },
      { outcomes: [{ decision: "ask", reason: "asks" }, { decision: "deny", reason: "no" }], expected: "deny", reason: "no" },
    ];
    for (const { outcomes, expected, reason } of cases) {
      const label = outcomes.map((o) => o.decision).join(",");
      const groups: HookGroup[] = outcomes.map(() => ({ matcher: "Bash", handlers: [mcpHook()] }));
      // Groups fire in declaration order and each holds one handler, so the
      // scripted client hands group N its own verdict.
      const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [scriptedClient(outcomes)]);
      expect(chain.decision, label).toBe(expected);
      // The reason travels with the decision, not with the first group.
      expect(chain.reason, label).toBe(reason);
      expect(chain.groups.map((g) => g.decision), label).toEqual(outcomes.map((o) => o.decision));
    }
  });
});

describe("layer merge", () => {
  function writeOperatorConfig(): void {
    writeFileSync(
      join(tmp, "config.json"),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: "Bash", handlers: [{ kind: "mcp", server: FAKE_SERVER, tool: "operator" }] }] },
      }),
    );
  }

  function writeClaudeSettings(): void {
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", handlers: [{ kind: "http", url: "https://guard.invalid/imported" }] }],
          Stop: [{ handlers: [{ kind: "mcp", server: FAKE_SERVER, tool: "note" }] }],
        },
      }),
    );
  }

  it("merges the operator config with the project .claude settings instead of replacing it", () => {
    writeOperatorConfig();
    writeClaudeSettings();
    const loaded = loadAllHooks({ ...defaultHookPaths(workspace), trustProjectClaudeSettings: true });
    expect(groupCount(loaded.entries, "PreToolUse")).toBe(2);
    expect(groupCount(loaded.entries, "Stop")).toBe(1);
    const preUse = loaded.entries.filter((entry) => entry.event === "PreToolUse").flatMap((entry) => entry.groups);
    expect(preUse.map((group) => group.handlers[0]?.kind)).toEqual(["mcp", "http"]);
    expect(loaded.sources.map((s) => s.source)).toEqual(["settings", "claude-settings"]);
    expect(loaded.sources.reduce((total, s) => total + s.count, 0)).toBe(loaded.entries.length);
  });

  it("keeps the operator's deny when the later imported layer allows the same call", async () => {
    writeOperatorConfig();
    writeClaudeSettings();
    const loaded = loadAllHooks({ ...defaultHookPaths(workspace), trustProjectClaudeSettings: true });
    const groups = loaded.entries.filter((entry) => entry.event === "PreToolUse").flatMap((entry) => entry.groups);
    expect(groups).toHaveLength(2);
    useHttpResponse(JSON.stringify({ decision: "allow" }));
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [
      decidingClient({ decision: "deny", reason: "operator rule" }),
    ]);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("operator rule");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("ignores a project .claude settings file until the operator trusts it", () => {
    writeOperatorConfig();
    writeClaudeSettings();
    const untrusted = loadAllHooks({ ...defaultHookPaths(workspace) });
    expect(loadedEvents(untrusted.entries)).toEqual(["PreToolUse"]);
    expect(untrusted.sources.map((s) => s.source)).toEqual(["settings"]);
    expect(untrusted.warnings).toEqual([]);
  });

  it("merges plugin hooks as an additional layer", () => {
    writeOperatorConfig();
    const plugin: ValidatedHookEntry[] = [{ event: "PreToolUse", groups: [{ matcher: "Edit", handlers: [mcpHook()] }] }];
    const loaded = loadAllHooks({ ...defaultHookPaths(workspace), pluginHooks: plugin });
    expect(loaded.entries).toHaveLength(2);
    expect(groupCount(loaded.entries, "PreToolUse")).toBe(2);
    expect(loaded.sources.map((s) => s.source)).toEqual(["settings", "plugin"]);
  });

  it("keeps the AGENTS.md frontmatter layer inert", () => {
    writeFileSync(
      join(workspace, "AGENTS.md"),
      `---\nhooks:\n  PreToolUse:\n    - handlers:\n        - kind: command\n          command: echo pwned\n---\n\n# Project\n`,
    );
    expect(loadAgentsHooks(join(workspace, "AGENTS.md"))).toEqual([]);
    const loaded = loadAllHooks({ ...defaultHookPaths(workspace), trustProjectClaudeSettings: true });
    expect(loaded.sources.map((s) => s.source)).not.toContain("agents");
  });

  it("resolves the settings path from JAA_HOME and the rest from the workspace", () => {
    const paths = defaultHookPaths(workspace);
    expect(paths.settingsPath).toBe(join(tmp, "config.json"));
    expect(paths.agentsPath).toBe(join(workspace, "AGENTS.md"));
    expect(paths.claudeSettingsPath).toBe(join(workspace, ".claude", "settings.json"));
  });

  it("treats a missing, unparseable or hookless config as no hooks at all", () => {
    const configPath = join(tmp, "config.json");
    expect(loadSettingsHooks(join(tmp, "absent.json"))).toEqual([]);
    writeFileSync(configPath, "{ not json");
    expect(loadSettingsHooks(configPath)).toEqual([]);
    writeFileSync(configPath, JSON.stringify({ hooks: [] }));
    expect(loadSettingsHooks(configPath)).toEqual([]);
    writeFileSync(configPath, JSON.stringify({ hooks: "nope" }));
    expect(loadSettingsHooks(configPath)).toEqual([]);
    writeFileSync(configPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", handlers: [] }] } }));
    expect(loadSettingsHooks(configPath)).toEqual([]);
    writeFileSync(configPath, JSON.stringify({ hooks: { PreToolUse: [{ handlers: [{ kind: "nope" }] }] } }));
    expect(loadSettingsHooks(configPath)).toEqual([]);
  });

  it("reads a project .claude settings file only through its own loader", () => {
    writeClaudeSettings();
    expect(loadClaudeSettingsHooks(join(workspace, ".claude", "settings.json"))).toHaveLength(2);
    expect(loadClaudeSettingsHooks(join(workspace, ".claude", "missing.json"))).toEqual([]);
  });
});

describe("parseHookConfig", () => {
  it("rebuilds every handler kind from a raw config", () => {
    const parsed = parseHookConfig({
      PreToolUse: [
        {
          matcher: "Bash",
          if: "Bash(rm:*)",
          handlers: [
            { kind: "command", command: "guard", args: ["--strict"], timeoutMs: 500 },
            { kind: "http", url: "https://guard.invalid/x", headers: { a: "b" } },
            { kind: "prompt", prompt: "judge", model: { provider: "ollama" } },
            { kind: "agent", prompt: "judge", model: { model: "llama3.2" } },
            { kind: "mcp", server: FAKE_SERVER, tool: "check", input: { a: 1 } },
          ],
        },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const group = parsed.entries[0]?.groups[0];
    expect(parsed.entries[0]?.event).toBe("PreToolUse");
    expect(group?.matcher).toBe("Bash");
    expect(group?.if).toBe("Bash(rm:*)");
    expect(group?.handlers.map((h) => h.kind)).toEqual(["command", "http", "prompt", "agent", "mcp"]);
    expect(group?.handlers[0]).toEqual({ kind: "command", command: "guard", args: ["--strict"], timeoutMs: 500 });
    expect(group?.handlers[3]).toEqual({ kind: "agent", prompt: "judge", model: { model: "llama3.2" } });
  });

  it("never leaves an absent optional key set to undefined", () => {
    const parsed = parseHookConfig({ Stop: [{ handlers: [{ kind: "command", command: "guard" }] }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const group = parsed.entries[0]?.groups[0];
    expect(group === undefined).toBe(false);
    expect("matcher" in (group ?? {})).toBe(false);
    expect("if" in (group ?? {})).toBe(false);
    expect(group?.handlers[0]).toEqual({ kind: "command", command: "guard" });
  });

  it("treats absent config as an empty chain", () => {
    expect(parseHookConfig(undefined)).toEqual({ ok: true, entries: [] });
    expect(parseHookConfig(null)).toEqual({ ok: true, entries: [] });
  });

  it("rejects malformed config without throwing", () => {
    const hostile: unknown[] = [
      "PreToolUse",
      42,
      ["PreToolUse"],
      { PreToolUse: "not-an-array" },
      { PreToolUse: [] },
      { PreToolUse: [{}] },
      { PreToolUse: [{ handlers: [] }] },
      { PreToolUse: [{ handlers: [{ kind: "exec", command: "x" }] }] },
      { PreToolUse: [{ handlers: [{ kind: "http", url: "not-a-url" }] }] },
      { PreToolUse: [{ handlers: [{ kind: "command", command: "x", timeoutMs: 0 }] }] },
      { PreToolUse: [{ handlers: [{ kind: "command", command: "x", timeoutMs: -1 }] }] },
      { PreToolUse: [{ handlers: [{ kind: "command" }] }] },
      { PreToolUse: [{ handlers: [{ kind: "prompt", prompt: "" }] }] },
      { PreToolUse: [{ matcher: "", handlers: [{ kind: "mcp", server: "a" }] }] },
      { PreToolUse: [{ handlers: [{ kind: "mcp", server: "a", tool: "b", input: "nope" }] }] },
    ];
    for (const input of hostile) {
      const label = JSON.stringify(input);
      let result: ReturnType<typeof parseHookConfig> | undefined;
      expect(() => {
        result = parseHookConfig(input);
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(false);
      if (result?.ok === false) expect(result.errors.length, label).toBeGreaterThan(0);
    }
  });

  it("silently skips an event it does not know, keeping the ones it does", () => {
    const parsed = parseHookConfig({
      FutureEventV2: [{ handlers: [{ kind: "command", command: "guard" }] }],
      PreToolUse: [{ handlers: [{ kind: "command", command: "guard" }] }],
      AnotherNewOne: [{ handlers: [{ kind: "command", command: "guard" }] }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(loadedEvents(parsed.entries)).toEqual(["PreToolUse"]);
  });

  it("reports the offending path for a malformed group", () => {
    const parsed = parseHookConfig({ PreToolUse: [{ handlers: [{ kind: "http", url: "nope" }] }] });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.join(" ")).toContain("PreToolUse.0.handlers.0.url");
  });

  it("rejects an http hook url that is relative rather than absolute", () => {
    // `fetch` only accepts an absolute URL, so a relative one can never work;
    // catching it here means the config is reported as malformed instead of the
    // hook denying later with a transport error the operator cannot act on.
    const relative: unknown[] = ["/foo", "foo", "../check", "//guard.invalid/x", "http:guard.invalid", "https:/guard.invalid"];
    for (const url of relative) {
      const input = { PreToolUse: [{ handlers: [{ kind: "http", url }] }] };
      const label = JSON.stringify(url);
      let result: ReturnType<typeof parseHookConfig> | undefined;
      expect(() => {
        result = parseHookConfig(input);
      }, label).not.toThrow();
      expect(result?.ok, label).toBe(false);
      if (result?.ok === false) {
        expect(result.errors.length, label).toBeGreaterThan(0);
        expect(result.errors.join(" "), label).toContain("PreToolUse.0.handlers.0.url");
      }
    }
  });

  it("accepts absolute http and https hook urls, and nothing off-scheme", () => {
    const absolute = ["https://guard.invalid/check", "http://guard.invalid", "http://127.0.0.1:8080/check"];
    for (const url of absolute) {
      const parsed = parseHookConfig({ PreToolUse: [{ handlers: [{ kind: "http", url }] }] });
      expect(parsed.ok, url).toBe(true);
      if (!parsed.ok) continue;
      const handler = parsed.entries[0]?.groups[0]?.handlers[0];
      expect(handler?.kind, url).toBe("http");
      expect(handler?.kind === "http" ? handler.url : undefined, url).toBe(url);
    }
    for (const url of ["ftp://guard.invalid/x", "file:///etc/passwd", "https://"]) {
      expect(parseHookConfig({ PreToolUse: [{ handlers: [{ kind: "http", url }] }] }).ok, url).toBe(false);
    }
  });
});

describe("partial hook config", () => {
  /**
   * A handler that is valid inside a JSON config file on any platform: the
   * running Node, in exec form, so no shell is involved.
   */
  function echoHandler(body: string): Record<string, unknown> {
    return { kind: "command", command: NODE, args: ["-e", `process.stdin.resume();process.stdout.write(${JSON.stringify(body)})`] };
  }

  function writeHooks(hooks: unknown): void {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ hooks }));
  }

  it("keeps the valid groups in a layer when one handler is malformed", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", handlers: [echoHandler("first")] },
        { matcher: "Write", handlers: [{ kind: "command" }] },
        { matcher: "Read", handlers: [echoHandler("third")] },
      ],
    });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(groupCount(loaded.entries, "PreToolUse")).toBe(2);
    expect(loaded.entries[0]?.groups.map((group) => group.matcher)).toEqual(["Bash", "Read"]);
    expect(loaded.sources).toEqual([{ source: "settings", count: 1 }]);
  });

  it("names the rejected entry with the validator's own path, in the CLI's format", () => {
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", handlers: [echoHandler("kept")] },
        { matcher: "Write", handlers: [{ kind: "command" }] },
      ],
    });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(loaded.warnings).toHaveLength(1);
    const warning = loaded.warnings[0] ?? "";
    // Same shape `hookConfigErrors` builds in src/cli/index.ts: a labelled count,
    // then the validator's message for each entry on its own indented line.
    expect(warning.split("\n")[0]).toBe("~/.jaa/config.json: 1 invalid hook entry/entries");
    expect(warning).toContain("\n  PreToolUse.1.handlers.0.command: ");
    expect(warning).toContain("~/.jaa/config.json");
  });

  it("still fires the valid groups that share a layer with a malformed one", async () => {
    // The whole point of per-entry parsing: a deny written next to a broken
    // handler has to reach the chain rather than vanish with it.
    const marker = join(tmp, "fired.txt");
    writeHooks({
      PreToolUse: [
        { matcher: "Bash", handlers: [echoHandler("noisy-neighbour")] },
        { matcher: "Write", handlers: [{ kind: "command" }] },
        {
          matcher: "Bash",
          handlers: [
            {
              kind: "command",
              command: NODE,
              args: [
                "-e",
                `let s="";process.stdin.on("data",(c)=>{s+=c});process.stdin.on("end",()=>{process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)},s);process.stdout.write(JSON.stringify({decision:"deny",reason:"guard ran"}))});`,
              ],
            },
          ],
        },
      ],
    });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    const groups = loaded.entries.flatMap((entry) => entry.groups);
    expect(groups).toHaveLength(2);
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST);
    expect(chain.groups.map((group) => group.fired)).toEqual([true, true]);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("guard ran");
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8")).toContain('"toolName":"Bash"');
    const warning = loaded.warnings[0] ?? "";
    expect(warning).toContain("PreToolUse.1.handlers.0.command: ");
  });

  it("keeps other events loading when one event's value has the wrong shape", () => {
    writeHooks({ PreToolUse: "not-an-array", Stop: [{ handlers: [echoHandler("stop")] }] });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(loadedEvents(loaded.entries)).toEqual(["Stop"]);
    const warning = loaded.warnings[0] ?? "";
    expect(warning.split("\n")[0]).toBe("~/.jaa/config.json: 1 invalid hook entry/entries");
    expect(warning).toContain("PreToolUse: expected an array of hook groups, got a string");
  });

  it("reports an event that is declared with no groups at all", () => {
    writeHooks({ PreToolUse: [] });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(loaded.entries).toEqual([]);
    expect(loaded.warnings[0] ?? "").toContain("PreToolUse: declared with no hook groups");
  });

  it("reports a hooks value that is not an object, and loads nothing from it", () => {
    for (const hooks of [[], "nope", 7]) {
      writeHooks(hooks);
      const loaded = loadAllHooks(defaultHookPaths(workspace));
      expect(loaded.entries, JSON.stringify(hooks)).toEqual([]);
      expect(loaded.warnings[0] ?? "", JSON.stringify(hooks)).toContain(
        "hooks config must be an object mapping event names to handler groups",
      );
    }
  });

  it("says nothing when the config is valid", () => {
    writeHooks({ PreToolUse: [{ handlers: [echoHandler("fine")] }], SomeFutureEvent: [{ handlers: [echoHandler("x")] }] });
    expect(loadAllHooks(defaultHookPaths(workspace)).warnings).toEqual([]);
  });

  it("reports a malformed .claude layer by its own label, not the operator's", () => {
    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({ hooks: { Stop: [{ handlers: [{ kind: "mcp", server: "s" }] }] } }),
    );
    const trusted = loadAllHooks({ ...defaultHookPaths(workspace), trustProjectClaudeSettings: true });
    expect(trusted.entries).toEqual([]);
    expect(trusted.warnings[0]?.startsWith(".claude/settings.json: 1 invalid hook entry/entries")).toBe(true);
    // Untrusted, the layer is not read at all — and not reported as an error.
    expect(loadAllHooks(defaultHookPaths(workspace)).warnings).toEqual([]);
  });

  it("reports a duplicate of the same mistake once per occurrence", () => {
    writeHooks({
      Stop: [
        { handlers: [{ kind: "command" }] },
        { handlers: [{ kind: "http", url: "nope" }] },
      ],
    });
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    const warning = loaded.warnings[0] ?? "";
    expect(warning.split("\n")[0]).toBe("~/.jaa/config.json: 2 invalid hook entry/entries");
    expect(warning).toContain("Stop.0.handlers.0.command: ");
    expect(warning).toContain("Stop.1.handlers.0.url: ");
  });
});

describe("parseHookConfigResilient", () => {
  const keep = { kind: "command", command: "guard" };

  it("is empty for absent input and never throws", () => {
    expect(parseHookConfigResilient(undefined)).toEqual({ entries: [], errors: [] });
    expect(parseHookConfigResilient(null)).toEqual({ entries: [], errors: [] });
    for (const input of ["PreToolUse", 42, ["PreToolUse"], true]) {
      let result: ReturnType<typeof parseHookConfigResilient> | undefined;
      expect(() => {
        result = parseHookConfigResilient(input);
      }).not.toThrow();
      expect(result?.entries, JSON.stringify(input)).toEqual([]);
      expect(result?.errors.length, JSON.stringify(input)).toBe(1);
    }
  });

  it("skips one bad group and keeps its siblings", () => {
    const parsed = parseHookConfigResilient({
      PreToolUse: [{ handlers: [keep] }, { handlers: [] }, {}, "nope", { handlers: [keep] }],
    });
    // Two messages can come back for one rejected group (the array minimum and
    // the group-level refine both fire on `handlers: []`), so count the groups
    // that survived rather than the lines.
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]?.groups).toHaveLength(2);
    const reported = parsed.errors.join("\n");
    expect(reported).toContain("PreToolUse.1.handlers: ");
    expect(reported).toContain("PreToolUse.1.(root): ");
    expect(reported).toContain("PreToolUse.2.handlers: ");
    expect(reported).toContain("PreToolUse.3.(root): ");
  });

  it("skips the whole group when one of its handlers is malformed", () => {
    // The drawn line: resilience is per group, not per handler. A handler
    // cannot be validated apart from the group that decides when it runs, so a
    // broken one costs its group — but never the groups beside it.
    const parsed = parseHookConfigResilient({
      PreToolUse: [{ matcher: "Bash", handlers: [keep, { kind: "command" }] }, { matcher: "Write", handlers: [keep] }],
    });
    expect(parsed.entries[0]?.groups.map((group) => group.matcher)).toEqual(["Write"]);
    expect(parsed.errors.join("\n")).toContain("PreToolUse.0.handlers.1.command: ");
  });

  it("registers nothing for an event whose every group failed", () => {
    const parsed = parseHookConfigResilient({ PreToolUse: [{ handlers: [] }], Stop: [{ handlers: [keep] }] });
    expect(loadedEvents(parsed.entries)).toEqual(["Stop"]);
    expect(parsed.errors.join("\n")).toContain("PreToolUse.0.handlers: ");
  });

  it("rejects a non-array and an empty list for an event", () => {
    const nonArray = parseHookConfigResilient({ PreToolUse: "nope", Stop: 5 });
    expect(nonArray.entries).toEqual([]);
    expect(nonArray.errors).toEqual([
      "PreToolUse: expected an array of hook groups, got a string",
      "Stop: expected an array of hook groups, got a number",
    ]);
    const empty = parseHookConfigResilient({ PreToolUse: [] });
    expect(empty.entries).toEqual([]);
    expect(empty.errors).toEqual(["PreToolUse: declared with no hook groups"]);
  });

  it("still skips an unknown event in silence, so a newer config still loads", () => {
    const parsed = parseHookConfigResilient({
      FutureEventV2: [{ handlers: [{ kind: "command" }] }],
      PreToolUse: [{ handlers: [keep] }],
    });
    expect(parsed.errors).toEqual([]);
    expect(loadedEvents(parsed.entries)).toEqual(["PreToolUse"]);
  });

  it("reports the same path a strict parse would, for the same mistake", () => {
    const input = { PreToolUse: [{ handlers: [{ kind: "http", url: "nope" }] }] };
    const strict = parseHookConfig(input);
    const resilient = parseHookConfigResilient(input);
    expect(strict.ok).toBe(false);
    if (strict.ok) return;
    expect(resilient.errors).toEqual(strict.errors);
  });
});

describe("AGENTS.md hook layer", () => {
  function writeAgents(body: string): void {
    writeFileSync(join(workspace, "AGENTS.md"), body);
  }

  const WITH_HOOKS = `---\nname: project\nhooks:\n  PreToolUse:\n    - handlers:\n        - kind: command\n          command: echo pwned\n---\n\n# Project\n`;

  it("tells the operator that a hooks key in the frontmatter is not read", () => {
    writeAgents(WITH_HOOKS);
    expect(loadAgentsHooks(join(workspace, "AGENTS.md"))).toEqual([]);
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(loaded.sources.map((source) => source.source)).not.toContain("agents");
    expect(loaded.warnings).toHaveLength(1);
    const warning = loaded.warnings[0] ?? "";
    expect(warning).toContain("AGENTS.md");
    expect(warning).toContain("NOT read");
    // Actionable: it says where to put them instead.
    expect(warning).toContain("~/.jaa/config.json");
  });

  it("stays quiet when the frontmatter has no hooks key", () => {
    writeAgents(`---\nname: project\ndescription: a project\ntriggers:\n  - "use when x"\n---\n\n# Project\n`);
    expect(loadAgentsHooks(join(workspace, "AGENTS.md"))).toEqual([]);
    expect(loadAllHooks(defaultHookPaths(workspace)).warnings).toEqual([]);
  });

  it("stays quiet for a file with no frontmatter at all", () => {
    writeAgents(`# Project\n\nThe word hooks: appears here but is not a declaration.\n`);
    expect(loadAllHooks(defaultHookPaths(workspace)).warnings).toEqual([]);
  });

  it("ignores a hooks mention in the body, and a nested one in the frontmatter", () => {
    writeAgents(`---\nname: project\nnotes:\n  hooks: not a top-level key\n---\n\n# Project\n\nhooks:\n  - in the body\n`);
    expect(loadAllHooks(defaultHookPaths(workspace)).warnings).toEqual([]);
  });

  it("does not treat an AGENTS.md rule as a hook", () => {
    // An AGENTS.md with no frontmatter is the common case, and the loudest
    // possible mistake would be warning about every project.
    writeAgents(`---\nname: project\n---\n\n## Conventions\n\n- No ESLint.\n`);
    const loaded = loadAllHooks(defaultHookPaths(workspace));
    expect(loaded.warnings).toEqual([]);
    expect(loaded.entries).toEqual([]);
  });
});

describe("matchers", () => {
  it("reads a bare name as exact, a separated list as a list, and anything else as a regex", () => {
    expect(parseMatcher(undefined)).toEqual({ type: "all" });
    expect(parseMatcher("")).toEqual({ type: "all" });
    expect(parseMatcher("*")).toEqual({ type: "all" });
    expect(parseMatcher("Bash")).toEqual({ type: "exact", value: "Bash" });
    expect(parseMatcher("Bash|Read")).toEqual({ type: "list", values: ["Bash", "Read"] });
    expect(parseMatcher("Bash, Read")).toEqual({ type: "list", values: ["Bash", "Read"] });
    expect(parseMatcher("^Bash$")).toEqual({ type: "regex", pattern: "^Bash$" });
    expect(parseMatcher("Bash(rm:*)")).toEqual({ type: "regex", pattern: "Bash(rm:*)" });
  });

  it("matches each form the way the matcher was written", () => {
    expect(matcherMatches({ type: "all" }, "anything")).toBe(true);
    expect(matcherMatches({ type: "exact", value: "Bash" }, "Bash")).toBe(true);
    expect(matcherMatches({ type: "exact", value: "Bash" }, "bash")).toBe(false);
    expect(matcherMatches({ type: "list", values: ["Bash", "Read"] }, "Read")).toBe(true);
    expect(matcherMatches({ type: "list", values: ["Bash", "Read"] }, "Write")).toBe(false);
    expect(matcherMatches({ type: "regex", pattern: "^B.*h$" }, "Bash")).toBe(true);
    expect(matcherMatches({ type: "regex", pattern: "^B.*h$" }, "Read")).toBe(false);
  });

  it("treats a broken regex as matching nothing rather than everything", () => {
    expect(matcherMatches({ type: "regex", pattern: "([unclosed" }, "anything")).toBe(false);
  });

  it("routes each event to the field its matcher filters on", () => {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"] as const) {
      expect(matcherField(event), event).toBe("toolName");
    }
    expect(matcherField("SubagentStart")).toBe("agentType");
    expect(matcherField("SubagentStop")).toBe("agentType");
    expect(matcherField("SessionStart")).toBe("startupSource");
    for (const event of ["SessionEnd", "UserPromptSubmit", "Stop", "ConfigChange"] as const) {
      expect(matcherField(event), event).toBe("all");
    }
  });

  it("never runs a handler for a tool the matcher does not name", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks("PreToolUse", oneGroup([mcpHook()], { matcher: "Write" }), bashPayload(), FAST, [recordingClient(record)]);
    expect(chain.groups[0]?.fired).toBe(false);
    expect(record).toEqual([]);
    expect(chain.decision).toBeUndefined();
  });

  it("matches a subagent group on the agent type", async () => {
    const record: string[] = [];
    const client = recordingClient(record);
    const fired = await decideFromHooks(
      "SubagentStart",
      oneGroup([mcpHook()], { matcher: "reviewer" }),
      buildPayload("SubagentStart", { agentType: "reviewer" }),
      FAST,
      [client],
    );
    const skipped = await decideFromHooks(
      "SubagentStart",
      oneGroup([mcpHook()], { matcher: "reviewer" }),
      buildPayload("SubagentStart", { agentType: "test-writer" }),
      FAST,
      [client],
    );
    expect(fired.groups[0]?.fired).toBe(true);
    expect(skipped.groups[0]?.fired).toBe(false);
    expect(record).toHaveLength(1);
  });
});

describe("if filters", () => {
  it("lets a group without an if always fire", () => {
    expect(ifFilterApplies({ handlers: [mcpHook()] }, {})).toBe(true);
    expect(ifFilterApplies({ handlers: [mcpHook()] }, { toolName: "Bash" })).toBe(true);
  });

  it("narrows a group to one tool by bare name", () => {
    expect(ifFilterApplies({ if: "Bash", handlers: [mcpHook()] }, { toolName: "Bash" })).toBe(true);
    expect(ifFilterApplies({ if: "Bash", handlers: [mcpHook()] }, { toolName: "Read" })).toBe(false);
    expect(ifFilterApplies({ if: "Bash", handlers: [mcpHook()] }, {})).toBe(false);
  });

  it("narrows a group to a command prefix", () => {
    const group: HookGroup = { if: "Bash(rm:*)", handlers: [mcpHook()] };
    expect(ifFilterApplies(group, { toolName: "Bash", toolInput: { command: "rm -rf /tmp/x" } })).toBe(true);
    expect(ifFilterApplies(group, { toolName: "Bash", toolInput: { command: "ls -la" } })).toBe(false);
    expect(ifFilterApplies(group, { toolName: "Read", toolInput: { command: "rm -rf /" } })).toBe(false);
    expect(ifFilterApplies(group, { toolName: "Bash" })).toBe(false);
  });

  it("narrows a group to a glob over a path argument", () => {
    const group: HookGroup = { if: "Edit(*.ts)", handlers: [mcpHook()] };
    expect(ifFilterApplies(group, { toolName: "Edit", toolInput: { path: "index.ts" } })).toBe(true);
    expect(ifFilterApplies(group, { toolName: "Edit", toolInput: { path: "README.md" } })).toBe(false);
    expect(ifFilterApplies(group, { toolName: "Edit" })).toBe(false);
  });

  it("keeps a single star inside one path segment and needs a double star to cross a slash", () => {
    const single: HookGroup = { if: "Edit(*.ts)", handlers: [mcpHook()] };
    const double: HookGroup = { if: "Edit(**/*.ts)", handlers: [mcpHook()] };
    const nested = { toolName: "Edit", toolInput: { path: "src/index.ts" } };
    expect(ifFilterApplies(single, nested)).toBe(false);
    expect(ifFilterApplies(double, nested)).toBe(true);
  });

  it("applies a tool filter only to tool events", async () => {
    const record: string[] = [];
    const chain = await decideFromHooks("Stop", oneGroup([mcpHook()], { if: "Bash" }), buildPayload("Stop"), FAST, [recordingClient(record)]);
    expect(chain.groups[0]?.fired).toBe(false);
    expect(record).toEqual([]);
  });

  it("drops a group whose if filter rejects the call and keeps the one it accepts", async () => {
    const record: string[] = [];
    const groups: HookGroup[] = [
      { matcher: "Bash", if: "Bash(rm:*)", handlers: [mcpHook()] },
      { matcher: "Bash", if: "Bash(npm:*)", handlers: [mcpHook()] },
    ];
    const chain = await decideFromHooks("PreToolUse", groups, bashPayload(), FAST, [recordingClient(record)]);
    expect(chain.groups.map((g) => g.fired)).toEqual([true, false]);
    expect(record).toHaveLength(1);
    expect(decode(record[0] ?? "{}")["toolInput"]).toEqual({ command: "rm -rf build" });
  });
});

describe("hook output clamping", () => {
  it("caps at 80 000 characters", () => {
    expect(MAX_HOOK_OUTPUT).toBe(80_000);
  });

  it("leaves output at or under the cap untouched", () => {
    const text = "a".repeat(MAX_HOOK_OUTPUT);
    expect(clampHookOutput(text)).toBe(text);
    expect(clampHookOutput("")).toBe("");
  });

  it("truncates past the cap and marks the cut", () => {
    const clamped = clampHookOutput("b".repeat(MAX_HOOK_OUTPUT + 5_000));
    expect(clamped.startsWith("b".repeat(MAX_HOOK_OUTPUT))).toBe(true);
    expect(clamped.endsWith("\n… [truncated]")).toBe(true);
    expect(clamped.length).toBe(MAX_HOOK_OUTPUT + "\n… [truncated]".length);
  });

  it("clamps what a command hook prints past the cap, and treats the remainder as no verdict", async () => {
    const chain = await decideFromHooks(
      "PreToolUse",
      oneGroup([floodingCommandHook(MAX_HOOK_OUTPUT + 20_000)], { matcher: "Bash" }),
      bashPayload(),
      FAST,
    );
    const stdout = chain.groups[0]?.handlers[0]?.stdout;
    expect(stdout?.endsWith("\n… [truncated]")).toBe(true);
    expect(stdout?.length).toBe(MAX_HOOK_OUTPUT + "\n… [truncated]".length);
    expect(chain.groups[0]?.handlers[0]?.decision).toBeUndefined();
    expect(chain.decision).toBeUndefined();
  });

  it("denies a blocking command that exits 2 with more output than the cap", async () => {
    const chain = await decideFromHooks("PreToolUse", oneGroup([floodingCommandHook(MAX_HOOK_OUTPUT + 20_000, 2)], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
  });

  it("reads a streamed http body normally when it is under the cap", async () => {
    useHttpStream(['{"decision":"deny","reason":"streamed no"}']);
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "http", url: "https://guard.invalid/check" }], { matcher: "Bash" }), bashPayload(), FAST);
    expect(chain.decision).toBe("deny");
    expect(chain.reason).toBe("streamed no");
  });

  it("clamps an oversized http body and fails the handler rather than honouring a truncated allow", async () => {
    // The body is valid JSON that would have parsed to an allow if it were not
    // cut, so this covers both the cap and the fail-closed reading of a verdict
    // too large to read.
    useHttpStream(['{"decision":"allow","pad":"', "d".repeat(MAX_HOOK_OUTPUT + 20_000), '"}']);
    const chain = await decideFromHooks("PreToolUse", oneGroup([{ kind: "http", url: "https://guard.invalid/check" }], { matcher: "Bash" }), bashPayload(), FAST);
    const stdout = chain.groups[0]?.handlers[0]?.stdout;
    expect(stdout?.endsWith("\n… [truncated]")).toBe(true);
    expect(stdout?.length).toBe(MAX_HOOK_OUTPUT + "\n… [truncated]".length);
    expect(chain.groups[0]?.handlers[0]?.ok).toBe(false);
    expect(chain.decision).toBe("deny");
  });
});

describe("event vocabulary", () => {
  it("refuses to build a payload for an event outside the union", () => {
    expect(HOOK_EVENTS.join(",")).not.toContain("FutureEventV2");
    for (const event of HOOK_EVENTS) {
      expect(buildPayload(event).hookEventName, event).toBe(event);
    }
  });
});
