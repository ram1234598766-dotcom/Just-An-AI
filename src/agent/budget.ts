/**
 * Token estimation + context trimming for the agent loop. No vendor tokenizer
 * here — a stable chars/4 heuristic (the same rule as the reference prototype's
 * estimate_tokens) is good enough to keep requests inside provider windows.
 *
 * Trimming guarantees: system messages are always kept; the most recent
 * non-system message is always kept (even if it alone overflows the budget —
 * that is a degenerate request, and truncating mid-message would corrupt tool
 * calls); assistant tool_call messages and their following tool results are
 * never split apart.
 */

import type { ChatMessage, ToolCall } from "../providers/types.js";

/** Default per-request context window for the loop. */
export const DEFAULT_TOKEN_BUDGET = 32_000;

/** Approximate per-message overhead (role, framing, whitespace). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** chars/4, floor of 1 — matches the reference estimate_tokens. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS + estimateTokens(msg.content);
  if (msg.toolCallId) tokens += MESSAGE_OVERHEAD_TOKENS;
  for (const call of msg.toolCalls ?? []) {
    tokens += estimateCallTokens(call);
  }
  return tokens;
}

function estimateCallTokens(call: ToolCall): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateTokens(call.name) + estimateTokens(call.arguments);
}

export function estimateChatTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

/**
 * Groups a transcript into atomic chunks so trimming can never orphan a tool
 * result from the assistant message that requested it. A chunk is either a
 * single system/user/plain-assistant message, or an assistant-with-toolCalls
 * message plus every tool result immediately following it.
 */
function chunkMessages(messages: ChatMessage[]): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role === "assistant" && (msg.toolCalls?.length ?? 0) > 0) {
      const chunk = [msg];
      i++;
      while (i < messages.length && messages[i]!.role === "tool") {
        chunk.push(messages[i]!);
        i++;
      }
      chunks.push(chunk);
      continue;
    }
    chunks.push([msg]);
    i++;
  }
  return chunks;
}

/**
 * Trims `messages` (oldest-first) to `budget` estimated tokens. No-op when
 * already within budget — returns the same array reference. Keeps all system
 * messages, then the newest chunks that fit, and never drops the newest
 * non-system chunk.
 */
export function trimToBudget(messages: ChatMessage[], budget: number = DEFAULT_TOKEN_BUDGET): ChatMessage[] {
  if (!Number.isFinite(budget)) return messages;
  const chunks = chunkMessages(messages);
  const chunkTokens = chunks.map((chunk) => estimateChatTokens(chunk));
  const total = chunkTokens.reduce((sum, t) => sum + t, 0);
  if (total <= budget) return messages;

  // System chunks are always kept.
  const keep: boolean[] = chunks.map((chunk) => chunk.every((m) => m.role === "system"));
  let used = 0;
  for (let i = 0; i < chunks.length; i++) {
    if (keep[i]!) used += chunkTokens[i]!;
  }

  // Walk newest -> oldest, keeping chunks that still fit.
  let keptAny = false;
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (keep[i]) continue;
    const tokens = chunkTokens[i]!;
    if (keptAny && used + tokens > budget) break;
    keep[i] = true;
    used += tokens;
    keptAny = true;
  }

  const trimmed: ChatMessage[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (keep[i]) trimmed.push(...chunks[i]!);
  }
  return trimmed;
}