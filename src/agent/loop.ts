/**
 * The agent loop: the Phase 3 core. Repeatedly asks a provider adapter for the
 * next assistant message; when the model proposes tool calls, runs them through
 * an injected executor (tool definitions/registry land in Phase 4) and feeds
 * the results back. Stops when the model gives a final answer (no tool calls)
 * or when the turn budget is exhausted.
 *
 * Context is trimmed to a token budget per request — the loop never violates a
 * provider context window — but the full untrimmed transcript is always
 * returned so callers can persist it in a session.
 */

import { DEFAULT_TOKEN_BUDGET, trimToBudget } from "./budget.js";
import type {
  ChatMessage,
  ChatRequest,
  ResolvedModel,
  ToolCall,
  ToolDef,
  Usage,
} from "../providers/types.js";

export const DEFAULT_MAX_TURNS = 20;

export const DEFAULT_SYSTEM_PROMPT =
  "You are J.A.A., a local-first, multi-provider terminal coding agent. " +
  "Be concise, precise, and show only what is needed.";

export interface ToolExecutor {
  (call: ToolCall): Promise<string>;
}

export interface AgentLoopOptions {
  /** Resolved provider + adapter (from the router); which model to call. */
  model: ResolvedModel;
  /** Initial transcript — a resumed session's history, or a fresh [system, user]. */
  messages: ChatMessage[];
  /** Tool definitions advertised to the model. Empty in Phase 3. */
  tools?: ToolDef[];
  /** Executes a tool call and returns its result text. */
  executeTool: ToolExecutor;
  /** Hard cap on loop iterations (model turns). Default 20. */
  maxTurns?: number;
  /** Context budget in estimated tokens. Default DEFAULT_TOKEN_BUDGET. */
  tokenBudget?: number;
  temperature?: number;
  /** Provider context window override (e.g. ollama num_ctx). */
  numContext?: number;
  /** Fired when the model produces an assistant message (before tool execution). */
  onAssistantMessage?: (msg: ChatMessage) => void;
  /** Fired before a tool call is executed. */
  onToolCall?: (call: ToolCall) => void;
  /** Fired after a tool call resolves (ok=false means the executor threw). */
  onToolResult?: (call: ToolCall, result: string, ok: boolean) => void;
}

export type StopReason = "completed" | "max_turns";

export interface AgentLoopResult {
  /** Full transcript (untrimmed) — assistant + tool messages in order. */
  messages: ChatMessage[];
  stopReason: StopReason;
  turns: number;
  /** Cumulative usage across every request sent. */
  usage: Usage;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const turns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const history: ChatMessage[] = [...options.messages];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 1; turn <= turns; turn++) {
    const request: ChatRequest = {
      model: options.model.model,
      messages: trimToBudget(history, budget),
    };
    if (options.tools !== undefined && options.tools.length > 0) request.tools = options.tools;
    if (options.temperature !== undefined) request.temperature = options.temperature;
    if (options.numContext !== undefined) request.numContext = options.numContext;

    const response = await options.model.adapter.chat(request);
    inputTokens += response.usage.inputTokens;
    outputTokens += response.usage.outputTokens;

    history.push(response.message);
    options.onAssistantMessage?.(response.message);

    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      return complete(history, turn, inputTokens, outputTokens);
    }

    for (const call of calls) {
      options.onToolCall?.(call);
      let result: string;
      let ok = true;
      try {
        result = await options.executeTool(call);
      } catch (err) {
        ok = false;
        result = `tool "${call.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      options.onToolResult?.(call, result, ok);
      history.push({ role: "tool", content: result, toolCallId: call.id });
    }
  }

  return {
    messages: history,
    stopReason: "max_turns",
    turns,
    usage: { inputTokens, outputTokens },
  };
}

function complete(
  messages: ChatMessage[],
  turns: number,
  inputTokens: number,
  outputTokens: number,
): AgentLoopResult {
  return { messages, stopReason: "completed", turns, usage: { inputTokens, outputTokens } };
}