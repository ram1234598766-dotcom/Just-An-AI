import { describe, expect, it } from "vitest";
import { decodeFrame, decodeFrames, encodeFrame } from "../src/lsp/framing.js";

describe("LSP framing", () => {
  it("encodes Content-Length using UTF-8 bytes", () => {
    const message = { jsonrpc: "2.0", id: 1, method: "test", params: { text: "é 🌍" } };
    const frame = encodeFrame(message);
    const body = JSON.stringify(message);
    expect(frame).toBe(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  });

  it("decodes split and coalesced frames", () => {
    const first = { jsonrpc: "2.0", id: 1, result: { value: "é" } };
    const second = { jsonrpc: "2.0", id: 2, result: { value: "🟢" } };
    const buffer = Buffer.from(encodeFrame(first) + encodeFrame(second), "utf8");
    const splitAt = 17;
    const firstPart = decodeFrames(buffer.subarray(0, splitAt));
    expect(firstPart.messages).toHaveLength(0);
    const remainder = Buffer.concat([Buffer.from(firstPart.leftover), buffer.subarray(splitAt)]);
    const decoded = decodeFrames(remainder);
    expect(decoded.messages.map((message) => message.json())).toEqual([first, second]);
    expect(decoded.leftover).toHaveLength(0);
  });

  it("accepts additional headers", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { kind: "full", items: [] } });
    const buffer = Buffer.from(
      `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
      "utf8",
    );
    const result = decodeFrame(buffer);
    expect(result?.message.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { kind: "full", items: [] } });
    expect(result?.consumed).toBe(buffer.length);
  });

  it("retains incomplete bodies", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, result: null });
    const frame = encodeFrame({ jsonrpc: "2.0", id: 1, result: null });
    const buffer = Buffer.from(frame, "utf8");
    expect(decodeFrame(buffer.subarray(0, buffer.length - 1))).toBeNull();
    expect(decodeFrame(buffer)?.message.json()).toEqual(JSON.parse(body));
  });

  it("rejects invalid content lengths", () => {
    expect(() => decodeFrame(Buffer.from("Content-Length: nope\r\n\r\n{}", "utf8"))).toThrow(/Content-Length/);
    expect(() => decodeFrame(Buffer.from("Content-Type: x\r\n\r\n{}", "utf8"))).toThrow(/Content-Length/);
    expect(() => decodeFrame(Buffer.from("Content-Length: 1\r\nContent-Length: 2\r\n\r\n{}", "utf8"))).toThrow(/Content-Length/);
    expect(() => decodeFrame(Buffer.from(`Content-Length: ${Number.MAX_SAFE_INTEGER}\r\n\r\n`, "utf8"))).toThrow(/Content-Length/);
  });
});
