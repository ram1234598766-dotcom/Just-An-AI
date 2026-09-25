import { spawn, type ChildProcess } from "node:child_process";
import { encodeFrame, decodeFrames, type McpMessage } from "./framing.js";
import { isRecord, isRequestId } from "./validation.js";
import type {
  McpInitializeResult,
  McpRequestId,
  McpTool,
  McpToolCallResult,
} from "./types.js";
import { MCP_PROTOCOL_VERSION } from "./types.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class McpClient {
  private proc: ChildProcess | undefined;
  private pending = new Map<McpRequestId, PendingRequest>();
  private leftover: Uint8Array = new Uint8Array(0);
  private initialized = false;
  private closed = false;
  private connectionError: Error | undefined;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;
  private connectPromise: Promise<void> | undefined;
  private detachProcess: (() => void) | undefined;
  serverInfo: { name: string; version: string } = { name: "unknown", version: "unknown" };
  private toolList: McpTool[] = [];

  readonly command: string;
  readonly args: string[];

  constructor(command: string, args: string[] = []) {
    this.command = command;
    this.args = args;
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal();
    return this.connectPromise;
  }

  get tools(): McpTool[] {
    return [...this.toolList];
  }

  get isReady(): boolean {
    return this.initialized && !this.closed;
  }

  hasTool(name: string): boolean {
    return this.toolList.some((tool) => tool.name === name);
  }

  async callTool(name: string, argsJson: string): Promise<McpToolCallResult> {
    if (!this.isReady) throw new Error("MCP client is not ready");
    let args: Record<string, unknown> = {};
    if (argsJson !== "") {
      const parsed: unknown = JSON.parse(argsJson);
      if (!isRecord(parsed)) throw new Error("MCP tool arguments must be a JSON object");
      args = parsed;
    }
    const result = await this.send<unknown>("tools/call", { name, arguments: args });
    return parseToolCallResult(result);
  }

  async waitForReady(): Promise<void> {
    return this.ready;
  }

  async disconnect(): Promise<void> {
    const proc = this.proc;
    this.closed = true;
    this.initialized = false;
    this.toolList = [];
    this.rejectAll(new Error("MCP client disconnected"));
    this.rejectReadyIfPending(new Error("MCP client disconnected"));
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
    this.connectionError = undefined;
    this.leftover = new Uint8Array(0);

    const stdout = proc.stdout;
    if (!stdout) {
      this.proc = undefined;
      throw new Error("MCP server has no stdout stream");
    }
    const onData = (chunk: Buffer) => this.handleData(chunk);
    const onError = (error: Error) => this.handleProcessFailure(error);
    const onExit = (code: number | null) => {
      this.closed = true;
      this.handleProcessFailure(new Error(`MCP server "${this.command}" exited with code ${code ?? "unknown"}`));
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
      const result = await this.send<unknown>("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "jaa", version: "0.1.0" },
      });
      const initializeResult = parseInitializeResult(result);
      this.serverInfo = initializeResult.serverInfo;
      this.writeFrame({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      this.initialized = true;
      if (initializeResult.capabilities.tools !== undefined) {
        const listResult = await this.send<unknown>("tools/list");
        this.toolList = parseToolList(listResult);
      } else {
        this.toolList = [];
      }
      this.resolveReadyOnce();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleProcessFailure(failure);
      await this.disconnect();
      throw failure;
    }
  }

  private handleData(chunk: Uint8Array): void {
    this.leftover = Buffer.concat([Buffer.from(this.leftover), Buffer.from(chunk)]);
    const { messages, leftover } = decodeFrames(this.leftover);
    this.leftover = leftover;
    for (const message of messages) this.handleMessage(message);
  }

  private handleMessage(message: McpMessage): void {
    let parsed: unknown;
    try {
      parsed = message.json();
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || !hasOwn(parsed, "id") || !isRequestId(parsed.id)) return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    const hasResult = hasOwn(parsed, "result");
    const hasError = hasOwn(parsed, "error");
    if (hasResult === hasError) return;
    clearTimeout(pending.timer);
    this.pending.delete(parsed.id);
    if (hasResult) {
      pending.resolve(parsed.result);
      return;
    }
    const errorValue = parsed.error;
    if (!isRecord(errorValue) || typeof errorValue.code !== "number" || typeof errorValue.message !== "string") {
      pending.reject(new Error("MCP server returned an invalid error response"));
      return;
    }
    pending.reject(new Error(errorValue.message));
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.proc?.stdin || this.closed || this.proc.stdin.destroyed) {
      return Promise.reject(new Error("MCP client is not connected"));
    }
    return new Promise<T>((resolve, reject) => {
      const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out (${REQUEST_TIMEOUT_MS}ms)`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.writeFrame({ jsonrpc: "2.0", id, method, params: params ?? {} });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeFrame(value: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) throw new Error("MCP client is not connected");
    stdin.write(Buffer.from(encodeFrame(value), "utf8"));
  }

  private handleProcessFailure(error: Error): void {
    if (!this.connectionError) this.connectionError = error;
    this.closed = true;
    this.rejectAll(error);
    this.rejectReadyIfPending(error);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private rejectReadyIfPending(error: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady(error);
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function parseInitializeResult(value: unknown): McpInitializeResult {
  if (!isRecord(value) || typeof value.protocolVersion !== "string" || value.protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new Error("MCP server returned an invalid initialize result");
  }
  if (!isRecord(value.capabilities) || !isRecord(value.serverInfo) || typeof value.serverInfo.name !== "string" || typeof value.serverInfo.version !== "string") {
    throw new Error("MCP server returned invalid initialize metadata");
  }
  return {
    protocolVersion: value.protocolVersion,
    capabilities: value.capabilities as McpInitializeResult["capabilities"],
    serverInfo: { name: value.serverInfo.name, version: value.serverInfo.version },
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

function parseToolList(value: unknown): McpTool[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) throw new Error("MCP server returned an invalid tools/list result");
  return value.tools.map((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error("MCP server returned an invalid tool definition");
    }
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new Error(`MCP tool "${tool.name}" has an invalid description`);
    }
    if (tool.inputSchema !== undefined && !isRecord(tool.inputSchema)) {
      throw new Error(`MCP tool "${tool.name}" has an invalid input schema`);
    }
    return {
      name: tool.name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
    };
  });
}

function parseToolCallResult(value: unknown): McpToolCallResult {
  if (!isRecord(value) || !Array.isArray(value.content)) throw new Error("MCP tool returned an invalid result");
  const content: McpToolCallResult["content"] = [];
  for (const block of value.content) {
    if (!isRecord(block) || typeof block.type !== "string") throw new Error("MCP tool returned invalid content");
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("MCP text content is invalid");
      content.push({ type: "text", text: block.text });
    } else if (block.type === "image" || block.type === "audio") {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string") {
        throw new Error(`MCP ${block.type} content is invalid`);
      }
      content.push({ type: block.type, data: block.data, mimeType: block.mimeType });
    } else {
      throw new Error(`MCP content type "${block.type}" is unsupported`);
    }
  }
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("MCP tool error flag is invalid");
  return {
    content,
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
  };
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
