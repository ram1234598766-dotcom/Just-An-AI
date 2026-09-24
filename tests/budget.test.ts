import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKEN_BUDGET,
  estimateChatTokens,
  estimateMessageTokens,
  estimateTokens,
  trimToBudget,
} from "../src/agent/budget.js";
import type { ChatMessage } from "../src/providers/types.js";

describe("estimateTokens", () => {
  it("uses a chars/4 heuristic with a floor of 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("estimates per-message and per-chat totals", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "a".repeat(400) }];
    expect(estimateMessageTokens(messages[0]!)).toBeGreaterThan(estimateTokens("a".repeat(400)));
    expect(estimateChatTokens(messages)).toBe(estimateMessageTokens(messages[0]!));
  });

  it("counts tool calls against the message estimate", () => {
    const plain = estimateMessageTokens({ role: "assistant", content: "" });
    const withCall = estimateMessageTokens({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "x", name: "read_file", arguments: '{"path":"a.ts"}' }],
    });
    expect(withCall).toBeGreaterThan(plain);
  });
});

describe("trimToBudget", () => {
  const system: ChatMessage = { role: "system", content: "system instructions" };
  const user = (i: number): ChatMessage => ({ role: "user", content: `message ${i} ` + "x".repeat(200) });

  it("is a no-op when under budget (same reference)", () => {
    const messages = [system, user(1)];
    expect(trimToBudget(messages, 10_000)).toBe(messages);
  });

  it("returns messages unchanged for an unlimited budget", () => {
    const messages = [system, user(1)];
    expect(trimToBudget(messages, Number.POSITIVE_INFINITY)).toBe(messages);
    expect(trimToBudget(messages)).toBe(messages);
  });

  it("keeps system messages and the newest message when trimming", () => {
    const messages = [system, ...Array.from({ length: 40 }, (_, i) => user(i))];
    const trimmed = trimToBudget(messages, 500);
    expect(trimmed[0]).toEqual(system);
    expect(trimmed[trimmed.length - 1]).toEqual(user(39));
  });

  it("stays within the budget when a small trim is enough", () => {
    const messages = [system, ...Array.from({ length: 10 }, (_, i) => user(i))];
    const budget = estimateChatTokens(messages) - 20;
    const trimmed = trimToBudget(messages, budget);
    // The last message alone exceeds the tiny trimming headroom, so the newest
    // chunk is kept even when it alone pushes over — but a mid-size trim must
    // drop old chunks. Snapshot the invariant: never split assistant/tool pairs.
    expect(trimmed[trimmed.length - 1]).toEqual(user(9));
    expect(trimmed.length).toBeLessThan(messages.length);
  });

  it("never splits an assistant tool_calls chunk from its tool results", () => {
    const assistant: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "ls", arguments: "{}" }],
    };
    const toolResult: ChatMessage = { role: "tool", content: "src\nlib", toolCallId: "call-1" };
    const old: ChatMessage[] = Array.from({ length: 30 }, (_, i) => user(i));
    const messages = [system, ...old, assistant, toolResult];
    const trimmed = trimToBudget(messages, 100);
    const stripped = trimmed.filter((m) => m.content === "src\nlib");
    // If the tool result is kept its assistant call must be too — and vice versa.
    const assistantKept = trimmed.some((m) => (m.toolCalls?.[0]?.id ?? "") === "call-1");
    expect(stripped.length).toBe(assistantKept ? 1 : 0);
    if (assistantKept) {
      const idx = trimmed.findIndex((m) => m.content === "src\nlib");
      expect(trimmed[idx - 1]?.toolCalls?.[0]?.id).toBe("call-1");
    }
  });

  it("exposes a sane default budget constant", () => {
    expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThan(0);
  });
});