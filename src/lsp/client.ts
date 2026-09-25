import { spawn, type ChildProcess } from "node:child_process";
import { encodeFrame, decodeFrames } from "./framing.js";
import type {
  LspInitializeParams,
  LspServerCapabilities,
  LspTextDocumentDiagnosticResult,
} from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Minimal LSP client for diagnostics. Spawns an LSP server process, sends
 * `initialize` + `textDocument/diagnostic`, and returns the diagnostic items.
 *
 */
export class LspClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<string | number, PendingRequest>();
  private leftover: Uint8Array = new Uint8Array(0);
  private capabilities: LspServerCapabilities = {};
  private closed = false;
  private connectPromise: Promise<void> | undefined;
  private detachProcess: (() => void) | undefined;

  readonly command: string;
  readonly args: string[];

  constructor(command: string, args: string[] = []) {
    this.command = command;
    this.args = args;
  }

  /** Spawn the LSP server and complete the initialize handshake. */
  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal();
    return this.connectPromise;
  }

  /** Request diagnostics for a file URI. */
  async getDiagnostics(uri: string): Promise<LspTextDocumentDiagnosticResult | null> {
    const result = await this.send<LspTextDocumentDiagnosticResult | null>(
      "textDocument/diagnostic",
      { textDocument: { uri } },
    );
    return result;
  }

  /** Server capabilities advertised during initialize. */
  get serverCapabilities(): LspServerCapabilities {
    return this.capabilities;
  }

  /** Terminate the LSP server process. */
  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.closed = true;
    this.rejectAll(new Error("client disconnected"));
    if (!proc) {
      this.detachProcess?.();
      this.detachProcess = undefined;
      this.proc = undefined;
      return;
    }

    if (proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.stdin?.end();
      } catch {
        // The process may have closed stdin already.
      }
      try {
        proc.kill();
      } catch {
        // The process may have exited between the checks.
      }
      await waitForExit(proc, 1_000);
      if (proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The process may have exited between the checks.
        }
        await waitForExit(proc, 1_000);
      }
    }
    this.detachProcess?.();
    this.detachProcess = undefined;
    this.proc = undefined;
  }

  private async connectInternal(): Promise<void> {
    const proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.closed = false;
    this.leftover = new Uint8Array(0);

    const stdout = proc.stdout;
    if (!stdout) {
      this.proc = undefined;
      throw new Error("LSP server has no stdout stream");
    }
    const onData = (chunk: Buffer) => this.handleData(chunk);
    const onError = (error: Error) => this.handleProcessFailure(error);
    const onExit = (code: number | null) => {
      this.closed = true;
      this.handleProcessFailure(new Error(`LSP server "${this.command}" exited with code ${code ?? "unknown"}`));
    };
    stdout.on("data", onData);
    stdout.on("error", onError);
    proc.stdin?.on("error", onError);
    proc.stderr?.resume();
    proc.on("error", onError);
    proc.on("exit", onExit);
    this.detachProcess = () => {
      stdout.removeListener("data", onData);
      stdout.removeListener("error", onError);
      proc.stdin?.removeListener("error", onError);
      proc.stderr?.removeListener("error", onError);
      proc.removeListener("error", onError);
      proc.removeListener("exit", onExit);
    };

    try {
      const initParams: LspInitializeParams = {
        processId: process.pid,
        clientInfo: { name: "jaa", version: "0.1.0" },
        capabilities: {
          textDocument: {
            diagnostic: {},
          },
        },
      };
      const result = await this.send<LspServerCapabilities & { capabilities: LspServerCapabilities }>(
        "initialize",
        initParams,
      );
      this.capabilities = result.capabilities ?? {};
      this.sendNotification("initialized", {});
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleProcessFailure(failure);
      await this.disconnect();
      throw failure;
    }
  }

  private handleProcessFailure(error: Error): void {
    this.rejectAll(error);
  }

  private handleData(chunk: Uint8Array): void {
    this.leftover = Buffer.concat([Buffer.from(this.leftover), Buffer.from(chunk)]);
    const { messages, leftover } = decodeFrames(this.leftover);
    this.leftover = leftover;
    for (const msg of messages) {
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: { json: () => unknown }): void {
    let parsed: unknown;
    try {
      parsed = msg.json();
    } catch {
      return;
    }

    const obj = parsed as { jsonrpc: string; id?: string | number; method?: string; result?: unknown; error?: unknown };
    if (obj.jsonrpc !== "2.0") return;

    if (obj.id !== undefined && obj.result !== undefined) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(obj.id);
        pending.resolve(obj.result);
      }
    } else if (obj.id !== undefined && obj.error) {
      const pending = this.pending.get(obj.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(obj.id);
        const err = obj.error as { message?: string };
        pending.reject(new Error(err.message ?? "LSP request failed"));
      }
    }
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) {
      return Promise.reject(new Error("LSP client is not connected"));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const frame = encodeFrame({ jsonrpc: "2.0", id, method, params: params ?? {} });
      const buf = Buffer.from(frame, "utf8");

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.proc?.stdin?.write(buf);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) return;
    const frame = encodeFrame({ jsonrpc: "2.0", method, params: params ?? {} });
    const buf = Buffer.from(frame, "utf8");
    this.proc?.stdin?.write(buf);
  }

  private rejectAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.removeListener("exit", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.once("exit", finish);
  });
}
