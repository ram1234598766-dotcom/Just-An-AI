import { describe, expect, it } from "vitest";
import {
  clip,
  formatToolCall,
  linesFromMessages,
  summarize,
  summarizeToolResult,
} from "../src/tui/render.js";
import type { ChatMessage } from "../src/providers/types.js";

describe("clip", () => {
  it("keeps short text unchanged", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("truncates long text to one line ending in ellipsis", () => {
    expect(clip("a".repeat(50), 10)).toBe(`${"a".repeat(10)} …`);
  });

  it("drops a newline that would split the clip", () => {
    expect(clip("xxxxxxxxxx\nyyyyyyyy", 12)).toBe("xxxxxxxxxx …");
  });

  it("normalizes CRLF", () => {
    expect(clip("a\r\nb", 10)).toBe("a\nb");
  });
});

describe("summarize", () => {
  it("collapses whitespace to a single line", () => {
    expect(summarize("one\n  two\t  three", 80)).toBe("one two three");
  });
});

describe("formatToolCall", () => {
  it("formats JSON arguments compactly", () => {
    expect(formatToolCall({ id: "t1", name: "write_file", arguments: '{"path":"a.txt"}' })).toBe(
      'write_file({"path":"a.txt"})',
    );
  });

  it("keeps raw arguments when they are not JSON", () => {
    expect(formatToolCall({ id: "t1", name: "bash", arguments: "not json" })).toBe("bash(not json)");
  });

  it("clips long argument blobs", () => {
    const call = formatToolCall({
      id: "t1",
      name: "write_file",
      arguments: JSON.stringify({ content: "x".repeat(500) }),
    });
    expect(call.endsWith(" …)")).toBe(true);
  });
});

describe("summarizeToolResult", () => {
  it("labels success and failure", () => {
    expect(summarizeToolResult("done", true)).toEqual({ text: "done", meta: "(ok)" });
    expect(summarizeToolResult("boom", false)).toEqual({ text: "boom", meta: "(failed)" });
  });
});

describe("linesFromMessages", () => {
  it("maps a transcript to ordered display lines", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are jaa" },
      { role: "user", content: "create a file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"x.txt","content":"hi"}' }],
      },
      { role: "tool", content: "created x.txt", toolCallId: "c1" },
      { role: "assistant", content: "done" },
    ];
    const lines = linesFromMessages(messages);
    expect(lines.map((l) => l.kind)).toEqual(["user", "toolCall", "toolResult", "assistant"]);
    expect(lines[0]?.kind).toBe("user");
    expect(lines[0]?.text).toBe("create a file");
    expect(lines[1]?.kind).toBe("toolCall");
    expect(lines[1]?.text).toBe('write_file({"path":"x.txt","content":"hi"})');
    expect(lines[2]?.kind).toBe("toolResult");
    expect(lines[2]?.text).toBe("created x.txt");
    expect(lines[2]?.meta).toBe("(tool)");
    expect(lines[3]?.kind).toBe("assistant");
    expect(lines[3]?.text).toBe("done");
  });

  it("assigns sequential ids from the given offset", () => {
    const lines = linesFromMessages([{ role: "user", content: "hi" }], 7);
    expect(lines[0]?.id).toBe(7);
  });

  it("does not emit empty assistant text", () => {
    const lines = linesFromMessages([{ role: "assistant", content: "" }]);
    expect(lines).toHaveLength(0);
  });
});