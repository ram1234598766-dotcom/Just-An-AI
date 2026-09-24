import type { AgentLoopResult } from "../agent/loop.js";
import type { ChatMessage } from "../providers/types.js";

/** Stable JSON shape for `ask --json`. Pure and unit-testable. */
export interface AskJsonResult {
  stopReason: string;
  turns: number;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number };
  /** The messages produced by THIS invocation only (the delta). */
  messages: ChatMessage[];
}

export function toJsonAskResult(
  result: AgentLoopResult,
  delta: ChatMessage[],
  provider: string,
  model: string,
): AskJsonResult {
  return {
    stopReason: result.stopReason,
    turns: result.turns,
    model,
    provider,
    usage: result.usage,
    messages: delta,
  };
}