import { beforeEach, describe, expect, it, vi } from "vitest";

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock("ollama", () => ({
  Ollama: class {
    chat = chatMock;
    constructor(_opts?: unknown) {}
  },
}));

import { createOllamaAdapter, mapMessages as mapOllama } from "../src/providers/ollama.js";

beforeEach(() => {
  chatMock.mockReset();
});

describe("ollama adapter", () => {
  it("maps nucContext to ollama num_ctx in the request options", async () => {
    const adapter = createOllamaAdapter({ id: "ollama", host: "http://localhost:11434" });
    chatMock.mockResolvedValue({
      model: "llama3.2:3b",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 1,
      eval_count: 1,
    });
    await adapter.chat({
      model: "llama3.2:3b",
      messages: [{ role: "user", content: "hi" }],
      numContext: 2048,
    });
    expect(chatMock).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ num_ctx: 2048 }) }),
    );
  });

  it("omits num_ctx when numContext is not provided", async () => {
    const adapter = createOllamaAdapter({ id: "ollama", host: "http://localhost:11434" });
    chatMock.mockResolvedValue({
      model: "llama3.2:3b",
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 1,
      eval_count: 1,
    });
    await adapter.chat({ model: "llama3.2:3b", messages: [{ role: "user", content: "hi" }] });
    expect(chatMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ options: expect.objectContaining({ num_ctx: expect.anything() }) }),
    );
  });

  it("keeps the ollama message mapping intact (no num_ctx side effects)", () => {
    const wire = mapOllama([{ role: "user", content: "hi" }]);
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });
});