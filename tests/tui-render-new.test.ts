import { describe, expect, it } from "vitest";
import { gauge, gaugeTone, expandMarkdown, formatDuration, formatTokens, splitCode, toolResultBody } from "../src/tui/render.js";

describe("splitCode", () => {
  it("separates prose from a fenced block", () => {
    const { prose, blocks } = splitCode("before\n\n```ts\nconst a = 1;\n```\n\nafter");
    expect(prose).toContain("before");
    expect(prose).toContain("after");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.language).toBe("ts");
    expect(blocks[0]?.text).toBe("const a = 1;");
  });

  it("treats an unterminated fence as code, because that is what streaming looks like", () => {
    // A half-arrived message has an opening fence and no closing one. Rendering
    // it as prose first would flash the syntax as text and then re-render.
    const { blocks } = splitCode("```py\nprint(1)\n");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.language).toBe("py");
  });

  it("keeps a language-less fence, tagged undefined rather than empty string", () => {
    const { blocks } = splitCode("```\nplain\n```");
    expect(blocks[0]?.language).toBeUndefined();
  });

  it("does not treat indented text as code", () => {
    // A model's wrapped sentence is often 4-space indented. Calling that a code
    // block makes ordinary prose unreadable.
    const { prose, blocks } = splitCode("a normal\n    continuation line");
    expect(blocks).toHaveLength(0);
    expect(prose).toContain("continuation");
  });

  it("handles two blocks and the prose between them", () => {
    const { prose, blocks } = splitCode("one\n```js\na\n```\ntwo\n```py\nb\n```\nthree");
    expect(blocks.map((b) => b.language)).toEqual(["js", "py"]);
    expect(prose).toContain("one");
    expect(prose).toContain("two");
    expect(prose).toContain("three");
  });
});

describe("expandMarkdown", () => {
  it("gives each paragraph its own row and each block a code row", () => {
    const rows = expandMarkdown("first para\n\nsecond para\n\n```ts\nconst a = 1;\n```", 0);
    expect(rows.map((r) => r.kind)).toEqual(["assistant", "assistant", "code"]);
    expect(rows[0]?.text).toBe("first para");
    expect(rows[2]?.code?.language).toBe("ts");
  });

  it("is stable for the same input, or a streamed row would churn every delta", () => {
    const text = "para\n\n```ts\na\n```\n\nafter";
    expect(expandMarkdown(text, 5)).toEqual(expandMarkdown(text, 5));
  });

  it("numbers rows from the offset it was given", () => {
    const rows = expandMarkdown("a\n\nb", 7);
    expect(rows.map((r) => r.id)).toEqual([7, 8]);
  });

  it("treats a half-arrived fence as code, so a code row appears mid-stream", () => {
    // The streaming case: the row count changes as the message grows, and the
    // TUI relies on the count being knowable. An unterminated fence is already
    // a code block by design, so the row is there before the closing fence lands.
    const partial = expandMarkdown("hello\n\n```ts\nconst a =", 0);
    const complete = expandMarkdown("hello\n\n```ts\nconst a = 1;\n```", 0);
    expect(partial.some((r) => r.kind === "code")).toBe(true);
    expect(complete.some((r) => r.kind === "code")).toBe(true);
    expect(complete.find((r) => r.kind === "code")?.text).toBe("const a = 1;");
  });
});

describe("formatDuration", () => {
  it("picks a unit that reads well", () => {
    expect(formatDuration(840)).toBe("840ms");
    expect(formatDuration(1200)).toBe("1.2s");
    expect(formatDuration(184_000)).toBe("3m 04s");
  });

  it("refuses to render a nonsense duration", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatTokens", () => {
  it("stays narrow", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1200)).toBe("1.2k");
    expect(formatTokens(47_300)).toBe("47k");
  });
});

describe("gauge", () => {
  it("fills proportionally and is always the requested width", () => {
    expect(gauge(0, 10)).toBe("░░░░░░░░░░");
    expect(gauge(1, 10)).toBe("██████████");
    expect(gauge(0.5, 10)).toBe("█████░░░░░");
    expect(gauge(0.33, 10).length).toBe(10);
  });

  it("clamps rather than throwing, because a display must not crash a turn", () => {
    expect(gauge(5, 4).length).toBe(4);
    expect(gauge(-1, 4).length).toBe(4);
    expect(gauge(Number.NaN, 4)).toBe("░░░░");
  });

  it("warns before the context is exhausted", () => {
    expect(gaugeTone(0.5)).toBe("ok");
    expect(gaugeTone(0.7)).toBe("warn");
    expect(gaugeTone(0.95)).toBe("critical");
  });
});

describe("toolResultBody", () => {
  it("is one line when collapsed and bounded when expanded", () => {
    const long = "x".repeat(9000);
    expect(toolResultBody(long, false)).toContain("…");
    expect(toolResultBody(long, false).length).toBeLessThan(200);
    // Expanded is still bounded: a tool that printed a megabyte must not take
    // over the transcript. The bound is the clip limit plus its " …" marker.
    expect(toolResultBody(long, true).length).toBeLessThanOrEqual(4002);
  });

  it("collapses newlines so a collapsed card stays one row", () => {
    expect(toolResultBody("a\nb\nc", false)).toBe("a b c");
  });
});
