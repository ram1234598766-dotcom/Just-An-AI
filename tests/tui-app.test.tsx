import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ChatApp } from "../src/tui/app.js";
import { createSession, saveSession } from "../src/agent/session.js";
import { recordCheckpoint } from "../src/checkpoint/store.js";
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
      // The idle hint now names the keys rather than the old prose, and points
      // at /help. Asserted as the operator would read it: which keys work, and
      // how to discover the rest.
      const idle = lastFrame();
      expect(idle).toContain("Enter send");
      expect(idle).toContain("/help");
      expect(idle).toContain("Ctrl+C");
      stdin.write("hello");
      await delay(50);
      expect(lastFrame()).toContain("hello");
    } finally {
      unmount();
    }
  });

  it("shows the model, token use and a context gauge before anything is sent", async () => {
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
        tokenBudget={200}
      />,
    );
    try {
      const idle = lastFrame();
      expect(idle).toContain("test/fake-model");
      expect(idle).toContain("turn 0");
      // The gauge is present from the first frame, not only after a turn, so a
      // long system prompt is visible before anything is spent.
      expect(idle).toContain("ctx");
      expect(idle).toMatch(/[█░]{5,}/);
      expect(idle).toContain("tok");

      stdin.write("hello");
      await delay(50);
      stdin.write("\r");
      await delay(80);
      const after = lastFrame();
      expect(after).toContain("turn 1");
      expect(after).toMatch(/tok \d+in\/\d+out/);
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
      // A tool is now a card, not a `→ name(args)` line followed by a `↳` line.
      // The assertions are on the parts a reader actually uses: the name, the
      // arguments, the verdict, the duration, and the result text.
      expect(frame).toContain("bash");
      expect(frame).toContain('{"command":"ls"}');
      expect(frame).toContain("✓");
      expect(frame).toContain("ls succeeded");
      expect(frame).toMatch(/\d+ms/);
      expect(frame).toContain("done");
      expect(frame).toContain("completed · 2 turn(s) · 16 in / 7 out");
      // The card replaces the old prefix, so its absence is asserted too.
      expect(frame).not.toContain("↳");
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

/**
 * `Esc Esc` on a saved session with a checkpoint.
 *
 * The prop under test is a preview switch, so both halves are asserted: with it
 * the rewind is described and stops, without it the rewind asks. Anything less
 * would pass whether the prop were honoured or not — a preview panel that always
 * appeared, or a confirmation that never did, would satisfy a one-sided test.
 */
describe("ChatApp rewind preview", () => {
  let tmp: string;
  let root: string;
  let file: string;
  const originalHome = process.env.JAA_HOME;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "jaa-tui-rewind-"));
    root = join(tmp, "workspace");
    process.env.JAA_HOME = tmp;
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.JAA_HOME;
    else process.env.JAA_HOME = originalHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A saved session holding one prompt and one snapshotted file. */
  function sessionWithACheckpoint() {
    const session = createSession();
    session.messages.push({ role: "user", content: "edit the note" });
    saveSession(session);
    file = join(root, "note.txt");
    writeFileSync(file, "body\n", "utf8");
    recordCheckpoint(session, file, 1, "call-1");
    return session;
  }

  /** `Esc Esc`, inside the double-tap window. */
  async function rewind() {
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={fakeModel([])}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
        sessionId={sessionWithACheckpoint().id}
        toolContext={{ root, cwd: root, allowBash: false }}
      />,
    );
    try {
      stdin.write("\x1b");
      await delay(50);
      stdin.write("\x1b");
      await delay(80);
      return lastFrame();
    } finally {
      unmount();
    }
  }

  it("describes the rewind and writes nothing when previewOnly is set", async () => {
    const session = sessionWithACheckpoint();
    const { stdin, lastFrame, unmount } = render(
      <ChatApp
        model={fakeModel([])}
        systemPrompt="you are jaa"
        executeTool={async () => "ok"}
        resumeMessages={[]}
        sessionId={session.id}
        previewOnly
        toolContext={{ root, cwd: root, allowBash: false }}
      />,
    );
    try {
      stdin.write("\x1b");
      await delay(50);
      stdin.write("\x1b");
      await delay(80);
      const frame = lastFrame();
      expect(frame).toContain("preview only");
      expect(frame).toContain("note.txt");
      expect(frame).not.toContain("confirm?");
      expect(readFileSync(file, "utf8")).toBe("body\n");
    } finally {
      unmount();
    }
  });

  it("asks for confirmation when previewOnly is absent", async () => {
    const frame = await rewind();
    expect(frame).toContain("confirm?");
    expect(frame).not.toContain("preview only");
    // Still unwritten: the confirmation is the gate, and no `y` was pressed.
    expect(readFileSync(file, "utf8")).toBe("body\n");
  });
});
