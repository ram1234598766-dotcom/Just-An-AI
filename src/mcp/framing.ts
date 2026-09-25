export interface McpMessage {
  raw: string;
  json(): unknown;
}

export function encodeFrame(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("MCP message is not JSON-serializable");
  return `${json}\n`;
}

export function decodeFrame(buffer: Uint8Array): { message: McpMessage; consumed: number } | null {
  const newline = buffer.indexOf(0x0a);
  if (newline === -1) return null;

  const end = newline > 0 && buffer[newline - 1] === 0x0d ? newline - 1 : newline;
  const raw = Buffer.from(buffer.subarray(0, end)).toString("utf8");
  return {
    message: { raw, json: () => JSON.parse(raw) },
    consumed: newline + 1,
  };
}

export function decodeFrames(buffer: Uint8Array): { messages: McpMessage[]; leftover: Uint8Array } {
  const messages: McpMessage[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const result = decodeFrame(buffer.subarray(offset));
    if (!result) break;
    messages.push(result.message);
    offset += result.consumed;
  }

  return { messages, leftover: buffer.subarray(offset) };
}
