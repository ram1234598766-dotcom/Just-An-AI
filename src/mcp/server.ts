import { stdin as processStdin, stdout as processStdout } from "node:process";
import type { Readable, Writable } from "node:stream";
import { decodeFrames, encodeFrame } from "./framing.js";
import { isRecord, isRequestId } from "./validation.js";
import { MCP_PROTOCOL_VERSION } from "./types.js";
import type { McpRequest, McpRequestId, McpResponse, McpTool, McpToolCallResult } from "./types.js";

export type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolCallResult>;

interface RegisteredTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  handler: ToolHandler;
}

export interface McpServerStreams {
  input: Readable;
  output: Writable;
}

export class McpServer {
  private readonly serverInfo: { name: string; version: string };
  private readonly tools = new Map<string, RegisteredTool>();
  private leftover: Uint8Array = new Uint8Array(0);
  private initialized = false;
  private initializeResponseSent = false;
  private running = false;
  private runPromise: Promise<void> | undefined;
  private finishRun: ((error?: Error) => void) | undefined;
  private readonly input: Readable;
  private readonly output: Writable;

  private readonly onData = (chunk: Buffer): void => {
    if (!this.running) return;
    this.leftover = Buffer.concat([Buffer.from(this.leftover), chunk]);
    const { messages, leftover } = decodeFrames(this.leftover);
    this.leftover = leftover;
    for (const message of messages) {
      void this.handleMessage(message).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.writeErrorResponse(null, -32603, `MCP server error: ${detail}`);
      });
    }
  };

  private readonly onEnd = (): void => {
    this.finish();
  };

  private readonly onError = (error: Error): void => {
    this.finish(error);
  };

  constructor(serverInfo: { name: string; version: string }, streams?: McpServerStreams) {
    this.serverInfo = serverInfo;
    this.input = streams?.input ?? processStdin;
    this.output = streams?.output ?? processStdout;
  }

  addTool(
    name: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
    handler: ToolHandler,
  ): void {
    if (name.trim().length === 0) throw new Error("MCP tool name must not be empty");
    if (this.tools.has(name)) throw new Error(`MCP tool already registered: ${name}`);
    this.tools.set(name, {
      ...(description !== undefined ? { description } : {}),
      ...(inputSchema !== undefined ? { inputSchema } : {}),
      handler,
    });
  }

  getToolNames(): string[] {
    return [...this.tools.keys()];
  }

  async run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.running = true;
    this.runPromise = new Promise<void>((resolve, reject) => {
      this.finishRun = (error?: Error) => {
        this.running = false;
        this.finishRun = undefined;
        this.cleanup();
        if (error) reject(error);
        else resolve();
      };
      this.input.on("data", this.onData);
      this.input.once("end", this.onEnd);
      this.input.once("error", this.onError);
    });
    return this.runPromise;
  }

  private cleanup(): void {
    this.input.removeListener("data", this.onData);
    this.input.removeListener("end", this.onEnd);
    this.input.removeListener("error", this.onError);
  }

  private finish(error?: Error): void {
    if (!this.running) return;
    this.running = false;
    this.finishRun?.(error);
  }

  private async handleMessage(message: { json: () => unknown }): Promise<void> {
    let parsed: unknown;
    try {
      parsed = message.json();
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const hasId = hasOwn(parsed, "id");
    if (parsed.jsonrpc !== "2.0") {
      if (hasId && isRequestId(parsed.id)) this.writeErrorResponse(parsed.id, -32600, "Invalid Request");
      return;
    }
    if (hasId && !isRequestId(parsed.id)) return;
    if (!hasId) {
      if (parsed.method === "notifications/initialized" && this.initializeResponseSent) this.initialized = true;
      return;
    }
    const id = parsed.id as McpRequestId;
    if (typeof parsed.method !== "string" || parsed.method.length === 0) {
      this.writeErrorResponse(id, -32600, "Invalid Request");
      return;
    }
    if (parsed.params !== undefined && !isRecord(parsed.params)) {
      this.writeErrorResponse(id, -32602, "Invalid params");
      return;
    }
    const request: McpRequest = {
      jsonrpc: "2.0",
      id,
      method: parsed.method,
      ...(parsed.params !== undefined ? { params: parsed.params } : {}),
    };
    const response = await this.handleRequest(request);
    if (response) this.writeResponse(response);
  }

  private async handleRequest(request: McpRequest): Promise<McpResponse> {
    const { id, method, params } = request;
    switch (method) {
      case "initialize": {
        const validation = this.validateInitializeParams(params);
        if (validation) return { jsonrpc: "2.0", id, error: validation };
        this.initializeResponseSent = true;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: this.serverInfo,
          },
        };
      }
      case "tools/list": {
        if (!this.initialized) return this.error(id, -32002, "Server is not initialized");
        const tools: McpTool[] = [...this.tools.entries()].map(([name, tool]) => ({
          name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
        }));
        return { jsonrpc: "2.0", id, result: { tools } };
      }
      case "tools/call": {
        if (!this.initialized) return this.error(id, -32002, "Server is not initialized");
        if (!params || typeof params.name !== "string" || params.name.length === 0) {
          return this.error(id, -32602, "Invalid params: tool name is required");
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isRecord(args)) return this.error(id, -32602, "Invalid params: arguments must be an object");
        const tool = this.tools.get(params.name);
        if (!tool) return this.error(id, -32601, `tool not found: ${params.name}`);
        try {
          return { jsonrpc: "2.0", id, result: await tool.handler(args) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: `tool error: ${message}` }], isError: true },
          };
        }
      }
      default:
        return this.error(id, -32601, `method not found: ${method}`);
    }
  }

  private validateInitializeParams(params: Record<string, unknown> | undefined): { code: number; message: string } | null {
    if (params?.protocolVersion !== undefined && params.protocolVersion !== MCP_PROTOCOL_VERSION) {
      return { code: -32602, message: "Unsupported MCP protocol version" };
    }
    if (params?.capabilities !== undefined && !isRecord(params.capabilities)) {
      return { code: -32602, message: "Invalid params: capabilities must be an object" };
    }
    if (params?.clientInfo !== undefined) {
      if (!isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string") {
        return { code: -32602, message: "Invalid params: clientInfo is invalid" };
      }
    }
    return null;
  }

  private error(id: McpRequestId, code: number, message: string): McpResponse {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  private writeErrorResponse(id: McpRequestId | null, code: number, message: string): void {
    if (id === null) return;
    this.output.write(encodeFrame({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  private writeResponse(response: McpResponse): void {
    this.output.write(encodeFrame(response));
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
