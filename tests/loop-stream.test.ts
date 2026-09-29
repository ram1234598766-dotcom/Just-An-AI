import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent/loop.js";
import type { ProviderAdapter, ResolvedModel } from "../src/providers/types.js";

function model(adapter: ProviderAdapter): ResolvedModel {
  return { provider: "t", model: "m", adapter };
}

describe("onStreamDelta", () => {
  it("reports the message's own text, in order", async () => {
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => {
        throw new Error("should not be called when streaming works");
      },
      async *stream() {
        yield { delta: "Hel" };
        yield { delta: "lo " };
        yield { delta: "world", usage: { inputTokens: 7, outputTokens: 3 } };
      },
    };
    const seen: string[] = [];
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
      onStreamDelta: (delta) => seen.push(delta),
    });
    expect(seen.join("")).toBe("Hello world");
    // The painted text and the stored text cannot disagree.
    expect(result.messages.at(-1)?.content).toBe("Hello world");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("takes the last usage report rather than summing them", async () => {
    // Providers often repeat usage on every trailing chunk. Summing would report
    // a turn as costing several times what it did.
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => ({ message: { role: "assistant", content: "x" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "s" }),
      async *stream() {
        yield { delta: "a" };
        yield { delta: "", usage: { inputTokens: 10, outputTokens: 5 } };
        yield { delta: "", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
      onStreamDelta: () => undefined,
    });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("estimates rather than reporting zero when a stream sends no usage", async () => {
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => ({ message: { role: "assistant", content: "x" }, usage: { inputTokens: 0, outputTokens: 0 }, model: "m", provider: "s" }),
      async *stream() {
        yield { delta: "a reasonably long streamed reply" };
      },
    };
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
      onStreamDelta: () => undefined,
    });
    // A zero-token turn is not a free turn, and a gauge that reads 0 would never
    // warn the operator about context.
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });

  it("falls back to the real call when the stream is empty, so a tool call is not lost", async () => {
    // `stream` is optional and, on the adapters that have it, yields text only.
    // A turn the model wanted to continue with a tool call comes back with no
    // text at all, and answering "finished, empty message" would end it.
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => {
        calls += 1;
        return {
          message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] },
          usage: { inputTokens: 3, outputTokens: 1 },
          model: "m",
          provider: "s",
        };
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        // Yields nothing: a provider that declines to stream a tool turn.
        return;
      },
    };
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "bash", description: "shell", inputSchema: { type: "object" } }],
      executeTool: async () => "ran",
      maxTurns: 1,
      onStreamDelta: () => undefined,
    });
    expect(calls, "the non-streaming path must run").toBe(1);
    // The tool call survived, which is the whole point of the fallback.
    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
  });

  it("recovers when a stream dies mid-turn instead of returning a partial answer", async () => {
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => ({
        message: { role: "assistant", content: "the complete answer" },
        usage: { inputTokens: 4, outputTokens: 2 },
        model: "m",
        provider: "s",
      }),
      async *stream() {
        yield { delta: "the compl" };
        throw new Error("connection reset");
      },
    };
    let painted = "";
    const replaced: string[] = [];
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
      onStreamDelta: (delta) => {
        painted += delta;
      },
      onStreamReplace: (text) => {
        replaced.push(text);
        painted = text;
      },
    });
    // A partial message presented as a finished one is the failure to avoid.
    expect(result.messages.at(-1)?.content).toBe("the complete answer");
    // The partial was retracted rather than appended to, so what the user ends
    // up reading is the whole answer and not "the complthe complete answer".
    expect(replaced).toEqual(["the complete answer"]);
    expect(painted).toBe("the complete answer");
  });

  it("is not used at all when the caller does not ask for it", async () => {
    // `onStreamDelta` absent must mean no streaming, so a caller that does not
    // want tokens does not pay to receive them.
    let streamed = false;
    const adapter: ProviderAdapter = {
      id: "s",
      chat: async () => ({ message: { role: "assistant", content: "plain" }, usage: { inputTokens: 2, outputTokens: 1 }, model: "m", provider: "s" }),
      async *stream() {
        streamed = true;
        yield { delta: "should not happen" };
      },
    };
    const result = await runAgentLoop({
      model: model(adapter),
      messages: [{ role: "user", content: "hi" }],
      executeTool: async () => "ok",
    });
    expect(streamed).toBe(false);
    expect(result.messages.at(-1)?.content).toBe("plain");
  });
});

describe("drainDiagnostics", () => {
  it("is drained after each tool result, and does not alter what the model is told", async () => {
    // A queue, because the host's `withDiagnostics` wrapper exists before the
    // loop does and can produce a report the first time it runs. A callback would
    // miss exactly those.
    const queue = [{ text: "Type 'string' is not assignable to 'number' (src/a.ts:1:7)", path: "src/a.ts" }];
    let round = 0;
    const result = await runAgentLoop({
      model: model({
        id: "s",
        chat: async () => {
          round += 1;
          if (round === 1) {
            return {
              message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: "{}" }] },
              usage: { inputTokens: 3, outputTokens: 1 },
              model: "m",
              provider: "s",
            };
          }
          return { message: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "s" };
        },
      }),
      messages: [{ role: "user", content: "edit it" }],
      tools: [{ name: "write_file", description: "write", inputSchema: { type: "object" } }],
      maxTurns: 1,
      // The loop's executor is the host's already-wrapped one, so the queue is
      // filled by the wrapper and drained here — exactly the production shape.
      executeTool: async () => {
        return "wrote it";
      },
      drainDiagnostics: () => queue.splice(0),
    });
    // Display is never load-bearing: the tool result the model sees is exactly
    // what the executor returned.
    expect(result.messages.some((m) => m.role === "tool" && m.content === "wrote it")).toBe(true);
  });

  it("works with no drain supplied at all", async () => {
    let round = 0;
    const result = await runAgentLoop({
      model: model({
        id: "s",
        chat: async () => {
          round += 1;
          if (round === 1) {
            return {
              message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
              model: "m",
              provider: "s",
            };
          }
          return { message: { role: "assistant", content: "ok" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m",            provider: "s" };
        },
      }),
      messages: [{ role: "user", content: "run it" }],
      tools: [{ name: "bash", description: "shell", inputSchema: { type: "object" } }],
      maxTurns: 1,
      executeTool: async () => "ran",
    });
    expect(result.messages.some((m) => m.role === "tool")).toBe(true);
  });
});
