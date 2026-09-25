export interface LspMessage {
  raw: string;
  json(): unknown;
}

const MAX_CONTENT_LENGTH = 16 * 1024 * 1024;

export function encodeFrame(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("LSP message is not JSON-serializable");
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

export function decodeFrame(buffer: Uint8Array): { message: LspMessage; consumed: number } | null {
  const headerEnd = findHeaderEnd(buffer);
  if (headerEnd === -1) return null;

  const headerText = Buffer.from(buffer.subarray(0, headerEnd)).toString("utf8");
  const lines = headerText.split("\r\n");
  let contentLength: number | undefined;
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`invalid LSP header: ${line}`);
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name !== "content-length") continue;
    if (contentLength !== undefined) throw new Error("duplicate LSP Content-Length header");
    if (!/^\d+$/.test(value)) throw new Error("invalid LSP Content-Length");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_CONTENT_LENGTH) {
      throw new Error("LSP Content-Length exceeds the maximum frame size");
    }
    contentLength = parsed;
  }
  if (contentLength === undefined) throw new Error("LSP frame is missing Content-Length");

  const bodyStart = headerEnd + 4;
  if (buffer.length < bodyStart + contentLength) return null;
  const raw = Buffer.from(buffer.subarray(bodyStart, bodyStart + contentLength)).toString("utf8");
  return {
    message: { raw, json: () => JSON.parse(raw) },
    consumed: bodyStart + contentLength,
  };
}

export function decodeFrames(buffer: Uint8Array): { messages: LspMessage[]; leftover: Uint8Array } {
  const messages: LspMessage[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const result = decodeFrame(buffer.subarray(offset));
    if (!result) break;
    messages.push(result.message);
    offset += result.consumed;
  }

  return { messages, leftover: buffer.subarray(offset) };
}

function findHeaderEnd(buffer: Uint8Array): number {
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (buffer[i] === 0x0d && buffer[i + 1] === 0x0a && buffer[i + 2] === 0x0d && buffer[i + 3] === 0x0a) {
      return i;
    }
  }
  return -1;
}
