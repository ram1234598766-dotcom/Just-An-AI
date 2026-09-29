import type { ChildProcess } from "node:child_process";
import type { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LspClient } from "../src/lsp/client.js";
import { decodeFrames, encodeFrame } from "../src/lsp/framing.js";

type Reply = { result?: unknown; error?: { code: number; message: string } };

/**
 * A scripted LSP server on in-memory pipes.
 *
 * The bug this file exists for cannot be reproduced reliably with a real server,
 * and does not need to be: the client asked for pull diagnostics, the server
 * answered with a hard error, and the client threw instead of using the push
 * channel it already had a subscription to. rust-analyzer is the server that
 * does this in the wild, and it cost a working language server a failed check.
 */
function fakeServer(handlers: {
  capabilities: Record<string, unknown>;
  /** Answers requests. Return `undefined` to answer "method not found". */
  onRequest: (method: string, params: unknown) => Reply | undefined;
  /** Called for every notification the client sends. */
  onNotification?: (method: string, params: unknown, send: (message: unknown) => void) => void;
}): LspClient {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const send = (message: unknown): void => {
    stdout.write(encodeFrame(message));
  };

  stdin.on("data", (chunk: Buffer) => {
    for (const message of decodeFrames(chunk).messages) {
      const request = message.json() as { id?: number | string; method?: string; params?: unknown };
      if (request.method === undefined) continue;
      if (request.id === undefined) {
        handlers.onNotification?.(request.method, request.params, send);
        continue;
      }
      if (request.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: request.id,
          result: { capabilities: handlers.capabilities, serverInfo: { name: "fake", version: "0" } },
        });
        continue;
      }
      const answer = handlers.onRequest(request.method, request.params);
      if (answer === undefined) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
      } else if (answer.error !== undefined) {
        send({ jsonrpc: "2.0", id: request.id, error: answer.error });
      } else {
        send({ jsonrpc: "2.0", id: request.id, result: answer.result ?? null });
      }
    }
  });

  // A PassThrough is a real EventEmitter, which the client relies on for
  // `removeListener`; the stdio streams and `kill` are bolted onto it.
  const proc = new PassThrough() as unknown as ChildProcess;
  Object.assign(proc, { stdin, stdout, stderr, kill: () => true, pid: 1, exitCode: null });

  return new LspClient(process.execPath, ["-e", ""], {
    cwd: process.cwd(),
    timeoutMs: 5_000,
    spawnImpl: (() => proc) as unknown as typeof spawn,
  });
}

const oneError = [
  { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "real error" },
];

describe("lsp: pull diagnostics are an optimisation, never a dependency", () => {
  it("falls back to push when a server advertises pull and then errors", async () => {
    // rust-analyzer's actual behaviour: `textDocument/diagnostic` is advertised,
    // and asking about a file it has not indexed is an error, not an empty result.
    const uri = "file:///tmp/project/src/main.rs";
    let pullAttempts = 0;
    const client = fakeServer({
      // `diagnosticProvider` at the top level is what the client looks for.
      capabilities: { diagnosticProvider: {}, textDocument: { publishDiagnostics: {} } },
      onRequest: (method) => {
        if (method !== "textDocument/diagnostic") return undefined;
        pullAttempts += 1;
        return { error: { code: -32603, message: "file not found: /tmp/project/src/main.rs" } };
      },
      // A real server publishes as soon as the document is open.
      onNotification: (method, _params, send) => {
        if (method === "textDocument/didOpen") {
          send({
            jsonrpc: "2.0",
            method: "textDocument/publishDiagnostics",
            params: { uri, diagnostics: oneError },
          });
        }
      },
    });

    try {
      await client.connect();
      client.openDocument(uri, "rust", "fn main() {}");
      const result = await client.diagnosticsFor(uri, 3_000);
      expect(pullAttempts, "pull must actually be tried, or this test proves nothing").toBe(1);
      expect(result?.items, "the push channel had the answer all along").toHaveLength(1);
      expect(result?.items[0]?.message).toBe("real error");
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  });

  it("still uses pull when it works, so the optimisation is not lost", async () => {
    const client = fakeServer({
      capabilities: { diagnosticProvider: {}, textDocument: { publishDiagnostics: {} } },
      onRequest: (method) =>
        method === "textDocument/diagnostic" ? { result: { kind: "full", items: oneError } } : undefined,
    });

    try {
      await client.connect();
      client.openDocument("file:///tmp/a.rs", "rust", "fn main() {}");
      const result = await client.diagnosticsFor("file:///tmp/a.rs", 3_000);
      expect(result?.items).toHaveLength(1);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  });

  it("resolves empty rather than throwing when both channels are silent", async () => {
    const client = fakeServer({
      capabilities: { diagnosticProvider: {}, textDocument: { publishDiagnostics: {} } },
      onRequest: (method) =>
        method === "textDocument/diagnostic" ? { error: { code: -32603, message: "internal error" } } : undefined,
    });

    try {
      await client.connect();
      client.openDocument("file:///tmp/b.rs", "rust", "fn main() {}");
      // Null means "the server said nothing", which the caller reports as an
      // empty set plus a reason — not as a crash.
      await expect(client.diagnosticsFor("file:///tmp/b.rs", 200)).resolves.toBeNull();
    } finally {
      await client.disconnect().catch(() => undefined);
    }
  });
});
