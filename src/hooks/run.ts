import { spawn } from "node:child_process";
import { McpClient } from "../mcp/client.js";
import { findMcpClient } from "../mcp/tools.js";
import { resolveModel } from "../providers/router.js";
import type { ChatMessage } from "../providers/types.js";
import type { HookDecisionOutput, HookHandler, HookHandlerResult, HookPayload, HookTimeouts } from "./types.js";
import { MAX_HOOK_OUTPUT } from "./types.js";
import { isHookEvent } from "./events.js";

/**
 * Run a single hook handler and return its result.
 *
 * Fail-closed: a hook that crashes or times out resolves to the safe default
 * (deny for pre-use, passthrough for post-use) rather than allowing.
 */
export async function runHookHandler(
  handler: HookHandler,
  payload: HookPayload,
  timeouts: HookTimeouts,
  mcpClients: McpClient[],
): Promise<HookHandlerResult> {
  const start = Date.now();
  let ok = false;
  let timedOut = false;
  let stdout = "";
  let error: string | undefined;
  let decision: HookDecisionOutput | undefined;

  try {
    switch (handler.kind) {
      case "command": {
        const timeout = handler.timeoutMs ?? timeouts.commandMs;
        const result = await runCommandHook(handler, payload, timeout);
        ok = result.ok;
        stdout = result.stdout;
        decision = result.decision;
        break;
      }
      case "http": {
        const timeout = handler.timeoutMs ?? timeouts.httpMs;
        const result = await runHttpHook(handler, payload, timeout);
        ok = result.ok;
        stdout = result.stdout;
        decision = result.decision;
        break;
      }
      case "prompt": {
        const timeout = handler.timeoutMs ?? timeouts.promptMs;
        const result = await runPromptHook(handler, payload, timeout);
        ok = result.ok;
        stdout = result.stdout;
        decision = result.decision;
        break;
      }
      case "agent": {
        const timeout = handler.timeoutMs ?? timeouts.agentMs;
        const result = await runAgentHook(handler, payload, timeout);
        ok = result.ok;
        stdout = result.stdout;
        decision = result.decision;
        break;
      }
      case "mcp": {
        const timeout = handler.timeoutMs ?? timeouts.mcpMs;
        const result = await runMcpHook(handler, payload, mcpClients, timeout);
        ok = result.ok;
        stdout = result.stdout;
        decision = result.decision;
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    const durationMs = Date.now() - start;
    return {
      index: -1, // caller sets
      handler,
      ok: ok && !timedOut,
      timedOut,
      durationMs,
      stdout,
      ...(error !== undefined ? { error } : {}),
      ...(decision !== undefined ? { decision } : {}),
    };
  }
}

/**
 * Reject if `work` has not settled within `timeoutMs`.
 *
 * A hook that hangs must fail closed on its own deadline, the same way a spawn
 * timeout or an aborted HTTP request does, instead of stalling the whole turn
 * on a handler that will never answer. The rejection is an ordinary Error, so
 * each caller's existing `catch` already handles it correctly.
 */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`hook timed out after ${timeoutMs}ms`)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  decision?: HookDecisionOutput | undefined;
}

async function runCommandHook(handler: Extract<HookHandler, { kind: "command" }>, payload: HookPayload, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const args = handler.args ?? [];
    const shell = handler.shell ?? (process.platform === "win32" ? "powershell" : "sh");

    let command: string;
    if (args.length === 0) {
      // Shell form: the hook's command is a shell script. Quote it so the
      // payload (which contains no shell metacharacters) is the only input.
      if (shell === "powershell") {
        command = `powershell -NoProfile -Command "${handler.command.replace(/"/g, '""')}"`;
      } else {
        command = `sh -c "${handler.command.replace(/"/g, '\\"')}"`;
      }
    } else {
      // Exec form: spawn directly, no shell tokenization.
      command = handler.command;
    }

    let stdout = "";
    let truncated = false;
    let timedOut = false;
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });

    // A hook's stdout is untrusted input of unbounded size, so only the first
    // MAX_HOOK_OUTPUT characters are ever held: a hook that prints forever costs
    // a bounded buffer instead of unbounded memory. Capping as the chunks arrive
    // rather than after close is the whole point — clamping at the end would
    // still have buffered everything first. A decision larger than the cap
    // therefore stops parsing, which is the fail-closed direction: the handler
    // reports no verdict rather than a truncated one being acted on.
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const room = MAX_HOOK_OUTPUT - stdout.length;
      if (text.length > room) {
        stdout += text.slice(0, Math.max(room, 0));
        truncated = true;
        return;
      }
      stdout += text;
    });

    // stderr is discarded: a hook's stderr is noise, and the exit code + stdout
    // are the only signals. Keeping it would surface debugging chatter to the
    // operator as if it were a hook decision.

    /** The stdout to report: the retained prefix, marked if anything was cut. */
    const clamped = (): string => (truncated ? markTruncated(stdout) : stdout);

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      resolve({ ok: false, stdout: clamped(), decision: undefined });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return; // already resolved
      const out = clamped();
      if (code === 2) {
        // Exit code 2 is blocking: the hook overrides the action regardless of
        // the permission engine's decision.
        try {
          resolve({ ok: true, stdout: out, decision: JSON.parse(out) });
        } catch {
          resolve({ ok: false, stdout: out, decision: undefined });
        }
        return;
      }
      if (code === 0) {
        try {
          resolve({ ok: true, stdout: out, decision: JSON.parse(out) });
        } catch {
          resolve({ ok: true, stdout: out, decision: undefined });
        }
        return;
      }
      // Non-zero exit without valid JSON is a non-blocking error.
      resolve({ ok: false, stdout: out, decision: undefined });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout: err instanceof Error ? err.message : String(err), decision: undefined });
    });
  });
}

interface HttpResult {
  ok: boolean;
  stdout: string;
  decision?: HookDecisionOutput | undefined;
}

/** Narrow an untyped body to one that can actually be streamed. */
function isStreamBody(body: unknown): body is ReadableStream<Uint8Array> {
  return typeof (body as { getReader?: unknown } | null)?.getReader === "function";
}

/**
 * Read a response body, keeping at most MAX_HOOK_OUTPUT characters.
 *
 * Streamed rather than `res.text()` so a hook endpoint that keeps sending
 * cannot grow this process's memory: past the cap the body is cancelled rather
 * than drained, so an oversized response costs neither memory nor the rest of
 * the download. A response with no readable stream (a 204, or a test double)
 * falls back to the buffered text, still clamped.
 *
 * Reports whether the cap was hit. The body is an http hook's only channel for
 * a verdict, so a body too large to read is a hook that failed to deliver one,
 * and the caller turns that into a failed handler — which denies on a blocking
 * event — rather than into a clean "no opinion".
 */
async function readBoundedBody(res: Response): Promise<{ text: string; truncated: boolean }> {
  const body: unknown = res.body;
  if (!isStreamBody(body)) {
    const text = await res.text();
    return { text: clampHookOutput(text), truncated: text.length > MAX_HOOK_OUTPUT };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < MAX_HOOK_OUTPUT) {
    const { done, value } = await reader.read();
    if (done) return { text: clampHookOutput(text + decoder.decode()), truncated: false };
    text += decoder.decode(value, { stream: true }).slice(0, MAX_HOOK_OUTPUT - text.length);
  }
  await reader.cancel();
  return { text: markTruncated(text), truncated: true };
}

async function runHttpHook(handler: Extract<HookHandler, { kind: "http" }>, payload: HookPayload, timeoutMs: number): Promise<HttpResult> {
  // Node's global fetch (stable since 21, and this package requires >=22) rather
  // than node-fetch, which was only ever a transitive dependency here.
  // The deadline is an AbortSignal, and an abort surfaces as a thrown AbortError
  // that the catch below turns into a failed handler — the same fail-closed
  // outcome a spawn timeout gives.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { ...handler.headers };
    const body = JSON.stringify(payload);
    const res = await fetch(handler.url, { method: "POST", headers, body, signal: controller.signal });
    const { text, truncated } = await readBoundedBody(res);
    let decision: HookDecisionOutput | undefined;
    try {
      decision = JSON.parse(text);
    } catch {
      // Non-JSON response is ignored.
    }
    return truncated ? { ok: false, stdout: text, decision: undefined } : { ok: res.ok, stdout: text, decision };
  } catch (err) {
    return { ok: false, stdout: err instanceof Error ? err.message : String(err), decision: undefined };
  } finally {
    clearTimeout(timer);
  }
}

interface PromptResult {
  ok: boolean;
  stdout: string;
  decision?: HookDecisionOutput | undefined;
}

async function runPromptHook(handler: Extract<HookHandler, { kind: "prompt" }>, payload: HookPayload, timeoutMs: number): Promise<PromptResult> {
  const model = resolveModel(handler.model);
  const messages: ChatMessage[] = [
    { role: "system", content: handler.prompt },
    { role: "user", content: JSON.stringify(payload) },
  ];
  try {
    const response = await withTimeout(model.adapter.chat({ model: model.model, messages }), timeoutMs);
    let decision: HookDecisionOutput | undefined;
    try {
      decision = JSON.parse(response.message.content);
    } catch {
      // Non-JSON response is ignored.
    }
    return { ok: true, stdout: response.message.content, decision };
  } catch (err) {
    return { ok: false, stdout: err instanceof Error ? err.message : String(err), decision: undefined };
  }
}

interface AgentResult {
  ok: boolean;
  stdout: string;
  decision?: HookDecisionOutput | undefined;
}

async function runAgentHook(handler: Extract<HookHandler, { kind: "agent" }>, payload: HookPayload, timeoutMs: number): Promise<AgentResult> {
  const { runSubagent } = await import("../agents/runner.js");
  const { loadAgents } = await import("../agents/index.js");
  const model = resolveModel(handler.model);
  const spec = {
    name: "hook-agent",
    description: "Hook agent",
    ownership: "*",
    deps: "none",
    acceptance: "none",
    instructions: handler.prompt,
  };
  try {
    const result = await withTimeout(
      runSubagent(loadAgents(), spec, {
        task: JSON.stringify(payload),
        model: { provider: model.provider, model: model.model },
        tools: false,
        maxTurns: 1,
        tokenBudget: 4000,
      }),
      timeoutMs,
    );
    let decision: HookDecisionOutput | undefined;
    try {
      decision = JSON.parse(result.messages[result.messages.length - 1]?.content ?? "");
    } catch {
      // Non-JSON response is ignored.
    }
    return { ok: true, stdout: result.messages.map((m) => m.content).join("\n"), decision };
  } catch (err) {
    return { ok: false, stdout: err instanceof Error ? err.message : String(err), decision: undefined };
  }
}

interface McpResult {
  ok: boolean;
  stdout: string;
  decision?: HookDecisionOutput | undefined;
}

async function runMcpHook(
  handler: Extract<HookHandler, { kind: "mcp" }>,
  payload: HookPayload,
  mcpClients: McpClient[],
  timeoutMs: number,
): Promise<McpResult> {
  const client = findMcpClient(mcpClients, handler.server);
  if (!client) {
    return { ok: false, stdout: `MCP server "${handler.server}" not connected`, decision: undefined };
  }
  try {
    const result = await withTimeout(client.callTool(handler.tool, JSON.stringify({ ...payload, ...handler.input })), timeoutMs);
    let decision: HookDecisionOutput | undefined;
    try {
      const text = result.content.find((c) => c.type === "text");
      if (text && typeof text === "object" && "text" in text) {
        decision = JSON.parse((text as { text: string }).text);
      }
    } catch {
      // Non-JSON response is ignored.
    }
    return { ok: true, stdout: JSON.stringify(result), decision };
  } catch (err) {
    return { ok: false, stdout: err instanceof Error ? err.message : String(err), decision: undefined };
  }
}

/**
 * Build a payload object for an event.
 *
 * Mirrors Claude Code's common fields. The payload is always valid JSON.
 */
export function buildPayload(event: string, input: Partial<HookPayload> = {}): HookPayload {
  if (!isHookEvent(event)) {
    // Reject rather than pass a name the hook vocabulary does not define: a
    // payload whose own `hookEventName` is unrecognisable cannot be routed.
    throw new Error(`unknown hook event "${event}"`);
  }
  const now = new Date().toISOString();
  // `SessionStart` always carries a source, defaulting to a plain start, so a
  // matcher written as e.g. `matcher: "startup"` has something to match. Every
  // other event leaves the field absent rather than `undefined`: a hook reading
  // the payload sees a key that is not there, not a key with a null value.
  const startupSource = input.startupSource ?? (event === "SessionStart" ? "startup" : undefined);
  return {
    hookEventName: event,
    sessionId: input.sessionId ?? "unknown",
    cwd: input.cwd ?? process.cwd(),
    timestamp: now,
    ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
    ...(startupSource !== undefined ? { startupSource } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(input.toolInput !== undefined ? { toolInput: input.toolInput } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
    ...(input.toolResponse !== undefined ? { toolResponse: input.toolResponse } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
    ...(input.agentType !== undefined ? { agentType: input.agentType } : {}),
    ...(input.compacted !== undefined ? { compacted: input.compacted } : {}),
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
  };
}

/**
 * Clamp hook output to MAX_HOOK_OUTPUT and mark truncation.
 */
export function clampHookOutput(text: string): string {
  if (text.length <= MAX_HOOK_OUTPUT) return text;
  return `${text.slice(0, MAX_HOOK_OUTPUT)}${TRUNCATION_MARKER}`;
}

/** Suffix `clampHookOutput` appends when it cuts. */
const TRUNCATION_MARKER = "\n… [truncated]";

/**
 * Mark an already-capped prefix as cut.
 *
 * The accumulating paths below cap as they read, so by the time they hand the
 * result on it is exactly MAX_HOOK_OUTPUT characters — a length `clampHookOutput`
 * considers within the cap. They therefore append the marker themselves, from
 * the same constant, rather than calling `clampHookOutput` on a string it would
 * leave alone.
 */
function markTruncated(prefix: string): string {
  return `${prefix}${TRUNCATION_MARKER}`;
}
