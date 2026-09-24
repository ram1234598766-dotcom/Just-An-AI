import { describe, expect, it } from "vitest";
import type { AgentLoopResult } from "../src/agent/loop.js";
import { toJsonAskResult } from "../src/cli/json.js";
import type { ChatMessage } from "../src/providers/types.js";

const delta: ChatMessage[] = [
  { role: "assistant", content: "hello from the test model" },
  { role: "tool", content: "ok", toolCallId: "c1" },
];

const result: AgentLoopResult = {
  messages: [...delta],
  stopReason: "completed",
  turns: 2,
  usage: { inputTokens: 100, outputTokens: 20 },
};

describe("toJsonAskResult", () => {
  it("maps loop results into a stable, serializable shape", () => {
    const json = toJsonAskResult(result, delta, "ollama", "llama3.2:3b");
    expect(json).toEqual({
      stopReason: "completed",
      turns: 2,
      model: "llama3.2:3b",
      provider: "ollama",
      usage: { inputTokens: 100, outputTokens: 20 },
      messages: delta,
    });
  });

  it("returns only the delta, never the full transcript", () => {
    const json = toJsonAskResult(result, delta, "ollama", "llama3.2:3b");
    expect(json.messages).toHaveLength(2);
    expect(json.messages).toBe(delta);
  });

  it("round-trips through JSON without loss", () => {
    const raw = JSON.stringify(toJsonAskResult(result, delta, "openai", "gpt-4o-mini"));
    const parsed = JSON.parse(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({ role: "assistant", content: "hello from the test model" });
    expect(parsed.messages[1]).toMatchObject({ role: "tool", content: "ok", toolCallId: "c1" });
  });
});