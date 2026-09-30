import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ChatApp } from "../src/tui/app.js";
import type { ChatStreamChunk, ProviderAdapter, ResolvedModel } from "../src/providers/types.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for `ready` to hold, polling until a deadline.
 *
 * Time-bounded rather than iteration-bounded on purpose. This suite runs
 * alongside 37 other files, several of which spawn real language servers, so a
 * poll count is a race that loses on a loaded machine — which is exactly how
 * three of these tests failed in a full run while passing alone. A wall-clock
 * budget scales with how slow the machine is instead of against it.
 */
async function waitFor(ready: (frame: string) => boolean, what: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    await delay(25);
    frame = lastFrameRef() ?? "";
    if (ready(frame)) return frame;
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}\n--- last frame ---\n${frame}`);
}

/** Set once per test, so `waitFor` can read the current frame. */
let lastFrameRef: () => string | undefined = () => undefined;

/** A model that streams, so the TUI's streaming path is what is under test. */
function streamingModel(chunks: string[], usage?: { inputTokens: number; outputTokens: number }): ResolvedModel {
  const adapter: ProviderAdapter = {
    id: "streamer",
    chat: async () => {
      throw new Error("this model streams; a non-streaming call should not happen");
    },
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<ChatStreamChunk> {
      for (const chunk of chunks) {
        await delay(10);
        yield { delta: chunk };
      }
      if (usage !== undefined) yield { delta: "", usage };
    },
  };
  return { provider: "streamer", model: "stream-model", adapter };
}

/** A model with no stream at all, to prove the fallback still works. */
function nonStreamingModel(content: string): ResolvedModel {
  const adapter: ProviderAdapter = {
    id: "plain",
    chat: async () => ({
      message: { role: "assistant", content },
      usage: { inputTokens: 8, outputTokens: 3 },
      model: "plain-model",
      provider: "plain",
    }),
  };
  return { provider: "plain", model: "plain-model", adapter };
}

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-tui-stream-"));
  process.env.JAA_HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
});

describe("streaming assistant output", () => {
  it("paints text as it arrives rather than all at once", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={streamingModel(["Hello ", "there, ", "world"], { inputTokens: 5, outputTokens: 3 })}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      lastFrameRef = lastFrame;
      stdin.write("hi");
      await delay(50);
      stdin.write("\r");
      // Wait for the first fragment rather than guessing a delay: the assertion
      // is that text appears *during* the stream, and a fixed sleep either races
      // the stream or measures the machine, not the behaviour.
      const partial = await waitFor((f) => f.includes("Hello"), "the first streamed fragment");
      expect(partial).toContain("Hello");
      // Not the whole reply yet, which is what makes it streaming rather than a
      // fast non-streaming call.
      expect(partial).not.toContain("Hello there, world");
      const complete = await waitFor((f) => f.includes("Hello there, world"), "the completed reply");
      // One row, not one per delta.
      expect(complete.match(/Hello there, world/g)?.length).toBe(1);
    } finally {
      unmount();
    }
  });

  it("never doubles a streamed message when the completed one arrives", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={streamingModel(["once"], { inputTokens: 2, outputTokens: 1 })}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      lastFrameRef = lastFrame;
      stdin.write("hi");
      await delay(50);
      stdin.write("\r");
      // `onAssistantMessage` fires with the same text after the stream ends. If
      // the TUI added it as a new row the reply would appear twice.
      const frame = await waitFor((f) => f.includes("turn 1"), "the turn to complete");
      expect(frame.match(/\bonce\b/g)?.length).toBe(1);
    } finally {
      unmount();
    }
  });

  it("renders a code fence that arrives across deltas", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={streamingModel(["Here:\n\n```ts\n", "const a = 1;\n", "```"], { inputTokens: 3, outputTokens: 8 })}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      lastFrameRef = lastFrame;
      stdin.write("code please");
      await delay(50);
      stdin.write("\r");
      const frame = await waitFor((f) => f.includes("const a = 1;"), "the code block to render");
      // Drawn as a block, not as prose containing fence characters.
      expect(frame).not.toContain("```");
      expect(frame).toMatch(/[╭│╰]/);
    } finally {
      unmount();
    }
  });

  it("falls back to a plain call when the provider cannot stream", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={nonStreamingModel("no stream here")}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
      />,
    );
    try {
      stdin.write("hi");
      await delay(30);
      stdin.write("\r");
      await delay(200);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("no stream here");
      expect(frame).toContain("completed");
    } finally {
      unmount();
    }
  });
});

describe("tool cards", () => {
  it("shows a card that moves from running to a verdict with a duration", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let round = 0;
    const adapter: ProviderAdapter = {
      id: "tools",
      chat: async () => {
        round += 1;
        // Round 1 asks for a tool, round 2 answers. `release` gates the *tool*,
        // not the model, so the mid-flight assertion is really about the card
        // being alive while the executor is still working.
        if (round === 1) {
          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }],
            },
            usage: { inputTokens: 4, outputTokens: 1 },
            model: "m",
            provider: "tools",
          };
        }
        return {
          message: { role: "assistant", content: "all done" },
          usage: { inputTokens: 2, outputTokens: 1 },
          model: "m",
          provider: "tools",
        };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={{ provider: "tools", model: "m", adapter }}
        systemPrompt="you are jaa"
        tools={[{ name: "read_file", description: "read", inputSchema: { type: "object" } }]}
        executeTool={async () => {
          await gate;
          return "the file contents";
        }}
        resumeMessages={[]}
      />,
    );
    try {
      lastFrameRef = lastFrame;
      stdin.write("read it");
      await delay(50);
      stdin.write("\r");
      // Wait for the card rather than assuming a delay, so the test is about the
      // card's lifecycle and not about how fast this machine is.
      const running = await waitFor((f) => f.includes("read_file"), "the card to appear");
      expect(running).toContain("running");
      expect(running).toContain("◐");

      release?.();
      const done = await waitFor((f) => f.includes("✓"), "the card to reach a verdict");
      expect(done).toContain("the file contents");
      expect(done).toMatch(/\d+ms/);
      // The running state is gone, not left behind as a duplicate card.
      expect(done).not.toContain("running");
    } finally {
      unmount();
    }
  });
});

describe("slash commands in the TUI", () => {
  it("answers /help without calling the model", async () => {
    let called = false;
    const adapter: ProviderAdapter = {
      id: "p",
      chat: async () => {
        called = true;
        return { message: { role: "assistant", content: "should not appear" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "p" };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <ChatApp model={{ provider: "p", model: "m", adapter }} systemPrompt="s" executeTool={async () => "ok"} resumeMessages={[]} />,
    );
    try {
      stdin.write("/help");
      await delay(50);
      stdin.write("\r");
      await delay(150);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("/rewind");
      expect(frame).toContain("Ctrl+C");
      // The point of a local command: no provider call, so no cost.
      expect(called, "a slash command must never reach the model").toBe(false);
      expect(frame).not.toContain("should not appear");
    } finally {
      unmount();
    }
  });

  it("offers a palette as a command is typed", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp model={nonStreamingModel("x")} systemPrompt="s" executeTool={async () => "ok"} resumeMessages={[]} />,
    );
    try {
      stdin.write("/re");
      await delay(60);
      const frame = lastFrame() ?? "";
      // Filtered, so only the matching command is offered.
      expect(frame).toContain("/rewind");
      expect(frame).not.toContain("/sessions");
    } finally {
      unmount();
    }
  });

  it("refuses an unknown command rather than spending a model call on it", async () => {
    let called = false;
    const adapter: ProviderAdapter = {
      id: "p",
      chat: async () => {
        called = true;
        return { message: { role: "assistant", content: "x" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "p" };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <ChatApp model={{ provider: "p", model: "m", adapter }} systemPrompt="s" executeTool={async () => "ok"} resumeMessages={[]} />,
    );
    try {
      stdin.write("/nope");
      await delay(50);
      stdin.write("\r");
      await delay(150);
      const frame = lastFrame() ?? "";
      expect(frame).toContain("unknown command");
      expect(called, "a typo must not be billed as a prompt").toBe(false);
    } finally {
      unmount();
    }
  });

  it("reports the model for /model", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp model={nonStreamingModel("x")} systemPrompt="s" executeTool={async () => "ok"} resumeMessages={[]} />,
    );
    try {
      stdin.write("/model");
      await delay(50);
      stdin.write("\r");
      await delay(120);
      expect(lastFrame() ?? "").toContain("plain/plain-model");
    } finally {
      unmount();
    }
  });
});

describe("key bindings", () => {
  it("needs two Ctrl+C presses to quit", async () => {
    let exited = 0;
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={nonStreamingModel("x")}
        systemPrompt="s"
        executeTool={async () => "ok"}
        resumeMessages={[]}
        onExit={() => {
          exited += 1;
        }}
      />,
    );
    try {
      stdin.write("\x03");
      await delay(60);
      // The first press only arms, so a stray interrupt cannot throw a
      // conversation away.
      expect(exited).toBe(0);
      expect(lastFrame() ?? "").toContain("again to quit");

      stdin.write("\x03");
      await delay(60);
      expect(exited).toBe(1);
    } finally {
      unmount();
    }
  });

  it("disarms the quit gesture on any other key", async () => {
    let exited = 0;
    const { stdin, unmount } = render(
      <ChatApp
        model={nonStreamingModel("x")}
        systemPrompt="s"
        executeTool={async () => "ok"}
        resumeMessages={[]}
        onExit={() => {
          exited += 1;
        }}
      />,
    );
    try {
      stdin.write("\x03");
      await delay(50);
      stdin.write("a");
      await delay(50);
      stdin.write("\x03");
      await delay(50);
      // The gesture has to be two presses in a row, not two presses ever.
      expect(exited).toBe(0);
    } finally {
      unmount();
    }
  });

  it("quits on Ctrl+D without asking twice", async () => {
    let exited = 0;
    const { stdin, unmount } = render(
      <ChatApp
        model={nonStreamingModel("x")}
        systemPrompt="s"
        executeTool={async () => "ok"}
        resumeMessages={[]}
        onExit={() => {
          exited += 1;
        }}
      />,
    );
    try {
      stdin.write("\x04");
      await delay(60);
      expect(exited).toBe(1);
    } finally {
      unmount();
    }
  });

  it("recalls the last prompt with the up arrow", async () => {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp model={nonStreamingModel("x")} systemPrompt="s" executeTool={async () => "ok"} resumeMessages={[]} />,
    );
    try {
      stdin.write("remember this");
      await delay(40);
      stdin.write("\r");
      await delay(200);
      stdin.write("\x1b[A");
      await delay(60);
      // History is a real convenience or it is noise; the text has to come back.
      expect(lastFrame() ?? "").toContain("remember this");
    } finally {
      unmount();
    }
  });

  it("expands a finished tool result with Ctrl+R", async () => {
    let round = 0;
    const adapter: ProviderAdapter = {
      id: "t",
      chat: async () => {
        round += 1;
        if (round === 1) {
          return {
            message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] },
            usage: { inputTokens: 1, outputTokens: 1 },
            model: "m",
            provider: "t",
          };
        }
        return { message: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, model: "m", provider: "t" };
      },
    };
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={{ provider: "t", model: "m", adapter }}
        systemPrompt="s"
        tools={[{ name: "bash", description: "shell", inputSchema: { type: "object" } }]}
        executeTool={async () => "many\nlines\nof\noutput"}
        resumeMessages={[]}
      />,
    );
    try {
      lastFrameRef = lastFrame;
      stdin.write("run it");
      await delay(50);
      stdin.write("\r");
      const collapsed = await waitFor((f) => f.includes("expand"), "the card to offer to expand");
      expect(collapsed).toContain("expand");

      stdin.write("\x12");
      // Expanded, and now offering to collapse again.
      const expanded = await waitFor((f) => f.includes("collapse"), "the card to expand");
      expect(expanded).toContain("lines");
    } finally {
      unmount();
    }
  });
});
