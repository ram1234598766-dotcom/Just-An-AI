import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_TURNS, runAgentLoop } from "../src/agent/loop.js";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ResolvedModel,
  ToolCall,
} from "../src/providers/types.js";

function scriptedAdapter(steps: ChatResponse[]): ProviderAdapter & { requested: ChatRequest[] } {
  let i = 0;
  const requested: ChatRequest[] = [];
  return {
    id: "scripted",
    async chat(req) {
      requested.push(req);
      const step = steps[i];
      i++;
      if (!step) throw new Error("script exhausted");
      return step;
    },
    requested,
  };
}

function makeModel(steps: ChatResponse[]): ResolvedModel & { adapter: ProviderAdapter & { requested: ChatRequest[] } } {
  const adapter = scriptedAdapter(steps);
  return { provider: "scripted", model: "script-model", adapter };
}

const assistant = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "script-model",
  provider: "scripted",
});

const withToolCalls = (calls: ToolCall[], content = ""): ChatResponse => ({
  message: { role: "assistant", content, toolCalls: calls },
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "script-model",
  provider: "scripted",
});

describe("runAgentLoop", () => {
  it("returns the assistant reply (completed) and accumulates usage", async () => {
    const model = makeModel([assistant("hello")]);
    const result = await runAgentLoop({
      model,
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "",
    });
    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(1);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(result.messages[1]?.content).toBe("hello");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("executes tool calls and feeds results back to the model", async () => {
    const probe = withToolCalls([{ id: "c1", name: "list_files", arguments: '{"path":"src"}' }]);
    const model = makeModel([probe, assistant("found them")]);
    const calls: string[] = [];
    const result = await runAgentLoop({
      model,
      messages: [{ role: "user", content: "list files" }],
      executeTool: async (call) => {
        calls.push(call.name);
        return "src\nlib";
      },
    });
    expect(calls).toEqual(["list_files"]);
    expect(result.stopReason).toBe("completed");
    expect(result.turns).toBe(2);
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(result.messages[2]).toEqual({
      role: "tool",
      content: "src\nlib",
      toolCallId: "c1",
    });
  });

  it("stops at max_turns when the model keeps calling tools", async () => {
    const call = { id: "c1", name: "ping", arguments: "{}" };
    const model = makeModel([withToolCalls([call]), withToolCalls([call]), withToolCalls([call])]);
    const result = await runAgentLoop({
      model,
      messages: [{ role: "user", content: "go" }],
      maxTurns: 3,
      executeTool: async () => "pong",
    });
    expect(result.stopReason).toBe("max_turns");
    expect(result.turns).toBe(3);
  });

  it("feeds executor errors back as tool results instead of crashing", async () => {
    const model = makeModel([
      withToolCalls([{ id: "c1", name: "explode", arguments: "{}" }]),
      assistant("boom handled"),
    ]);
    const result = await runAgentLoop({
      model,
      messages: [{ role: "user", content: "run tool" }],
      executeTool: async () => {
        throw new Error("kaboom");
      },
    });
    expect(result.stopReason).toBe("completed");
    expect(result.messages[2]?.content).toMatch(/kaboom/);
    expect(result.messages[2]?.content).toMatch(/explode/);
  });

  it("trims per-request context to the token budget but returns the full transcript", async () => {
    const model = makeModel([assistant("done")]);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, content: `m${i} ` + "x".repeat(200) })),
    ];
    const result = await runAgentLoop({
      model,
      messages,
      tokenBudget: 120,
      executeTool: async () => "",
    });
    const sent = model.adapter.requested[0]!.messages;
    expect(estimateChatTokensUnsafe(sent)).toBeLessThanOrEqual(120 + 64); // system + newest kept anyway
    expect(result.messages).toHaveLength(messages.length + 1);
  });

  it("surfaces events for the TUI to render", async () => {
    const model = makeModel([
      withToolCalls([{ id: "c1", name: "ls", arguments: "{}" }], "thinking"),
      assistant("answer"),
    ]);
    const events: string[] = [];
    const result = await runAgentLoop({
      model,
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
      onAssistantMessage: () => events.push("assistant"),
      onToolCall: () => events.push("tool-call"),
      onToolResult: (_, __, ok) => events.push(`tool-result:${ok}`),
    });
    expect(events).toEqual(["assistant", "tool-call", "tool-result:true", "assistant"]);
    expect(result.turns).toBe(2);
  });

  it("has a reasonable default turn cap", () => {
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(0);
  });
});

/** Rough token check without importing the budget module (keeps the test honest). */
function estimateChatTokensUnsafe(messages: ChatRequest["messages"]): number {
  return messages.reduce((sum, m) => sum + Math.max(1, Math.ceil(m.content.length / 4)), 0);
}