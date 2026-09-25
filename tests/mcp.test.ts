import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { decodeFrames, encodeFrame, type McpMessage } from "../src/mcp/framing.js";
import { McpServer } from "../src/mcp/server.js";

function parseMessages(chunks: Buffer[]): unknown[] {
  const output = Buffer.concat(chunks);
  return decodeFrames(output).messages.map((message) => message.json());
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("MCP framing", () => {
  it("encodes newline-delimited JSON without LSP headers", () => {
    const frame = encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
    expect(frame).not.toContain("Content-Length");
    expect(frame.endsWith("\n")).toBe(true);
    expect(frame.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(frame.trim())).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  });

  it("round trips Unicode and split frames", () => {
    const value = { jsonrpc: "2.0", method: "test", params: { text: "héllo 🌍" } };
    const bytes = Buffer.from(encodeFrame(value), "utf8");
    const split = Math.floor(bytes.length / 2);
    const first = decodeFrames(bytes.subarray(0, split));
    expect(first.messages).toHaveLength(0);
    const second = decodeFrames(Buffer.concat([Buffer.from(first.leftover), bytes.subarray(split)]));
    expect(second.messages[0]?.json()).toEqual(value);
    expect(second.leftover).toHaveLength(0);
  });

  it("decodes coalesced and CRLF messages", () => {
    const first = { jsonrpc: "2.0", id: 1, result: { value: "é" } };
    const second = { jsonrpc: "2.0", id: 2, result: { value: "🟢" } };
    const buffer = Buffer.from(
      `${JSON.stringify(first)}\r\n${JSON.stringify(second)}\r\n`,
      "utf8",
    );
    const decoded = decodeFrames(buffer);
    expect(decoded.messages.map((message) => message.json())).toEqual([first, second]);
    expect(decoded.leftover).toHaveLength(0);
  });

  it("retains an incomplete trailing message", () => {
    const buffer = Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}', "utf8");
    const decoded = decodeFrames(buffer);
    expect(decoded.messages).toHaveLength(0);
    expect(Buffer.from(decoded.leftover)).toEqual(buffer);
  });

  it("throws when a complete line is not valid JSON", () => {
    expect(() => {
      const message: McpMessage = { raw: "not-json", json: () => JSON.parse("not-json") };
      message.json();
    }).toThrow();
  });
});

describe("McpServer", () => {
  it("enforces initialization and handles notifications without a response", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { input, output },
    );
    const run = server.run();

    input.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    await flush();
    expect(parseMessages(chunks)[0]).toMatchObject({ id: 1, error: { code: -32002 } });

    input.write(
      encodeFrame({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test" } },
      }),
    );
    await flush();
    expect(parseMessages(chunks)[1]).toMatchObject({
      id: 2,
      result: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
    });

    const beforeNotification = chunks.length;
    input.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
    await flush();
    expect(chunks.length).toBe(beforeNotification);

    input.write(encodeFrame({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }));
    await flush();
    expect(parseMessages(chunks)[2]).toMatchObject({ id: 3, result: { tools: [] } });

    input.end();
    await run;
  });

  it("validates tools/call arguments and keeps the server alive after tool errors", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    let calls = 0;
    const server = new McpServer(
      { name: "test-server", version: "1.0.0" },
      { input, output },
    );
    server.addTool("echo", "Echo text", { type: "object", properties: { text: { type: "string" } } }, async (args) => {
      calls++;
      if (args.text === "fail") throw new Error("expected failure");
      return { content: [{ type: "text", text: String(args.text) }] };
    });
    const run = server.run();

    input.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }));
    input.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    input.write(encodeFrame({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: [] } }));
    input.write(encodeFrame({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "fail" } } }));
    await flush();
    const messages = parseMessages(chunks) as Array<{ id: number; result?: { isError?: boolean }; error?: { code: number } }>;
    expect(messages.find((message) => message.id === 2)?.error?.code).toBe(-32602);
    expect(messages.find((message) => message.id === 3)?.result?.isError).toBe(true);
    expect(calls).toBe(1);

    input.end();
    await run;
  });
});
