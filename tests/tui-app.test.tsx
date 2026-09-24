import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ChatApp } from "../src/tui/app.js";
import type { ProviderAdapter, ChatResponse, ResolvedModel } from "../src/providers/types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeModel(responses: ChatResponse[]): ResolvedModel {
  const adapter: ProviderAdapter = {
    id: "test",
    chat: async () => {
      const next = responses.shift();
      if (!next) throw new Error("fake adapter ran out of scripted responses");
      return next;
    },
  };
  return { provider: "test", model: "fake-model", adapter };
}

describe("ChatApp (ink-testing-library)", () => {
  it("renders the idle hint and echoes typed input", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={fakeModel([
          {
            message: { role: "assistant", content: "hi" },
            usage: { inputTokens: 4, outputTokens: 2 },
            model: "fake-model",
            provider: "test",
          },
        ])}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      expect(lastFrame()).toContain("type a message and press Enter");
      stdin.write("hello");
      await delay(50);
      expect(lastFrame()).toContain("hello");
    } finally {
      unmount();
    }
  });

  it("drives a tool round-trip and shows the final answer", async () => {
    const responses: ChatResponse[] = [
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "bash", arguments: '{"command":"ls"}' }],
        },
        usage: { inputTokens: 10, outputTokens: 5 },
        model: "fake-model",
        provider: "test",
      },
      {
        message: { role: "assistant", content: "done" },
        usage: { inputTokens: 6, outputTokens: 2 },
        model: "fake-model",
        provider: "test",
      },
    ];
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={fakeModel(responses)}
        systemPrompt="you are jaa"
        tools={[{ name: "bash", description: "shell", inputSchema: { type: "object" } }]}
        executeTool={async () => "ls succeeded"}
        resumeMessages={[]}
      />,
    );
    try {
      stdin.write("list files");
      await delay(50);
      stdin.write("\r");
      await delay(80);
      const frame = lastFrame();
      expect(frame).toContain("❯ list files");
      expect(frame).toContain('→ bash({"command":"ls"})');
      expect(frame).toContain("↳ ls succeeded (ok)");
      expect(frame).toContain("done");
      expect(frame).toContain("completed · 2 turn(s) · 16 in / 7 out");
    } finally {
      unmount();
    }
  });

  it("surfaces loop failures as an error line", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={fakeModel([])}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      stdin.write("make it break");
      await delay(50);
      stdin.write("\r");
      await delay(80);
      const frame = lastFrame();
      expect(frame).toContain("loop failed:");
      expect(frame).toContain("error — type a message and press Enter to retry");
    } finally {
      unmount();
    }
  });
});