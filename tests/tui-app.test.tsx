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
