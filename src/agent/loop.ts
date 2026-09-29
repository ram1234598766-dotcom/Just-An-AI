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
 *
 * Phase 13 (hooks) and Phase 14 (checkpoints) are wired in here, at the only
 * place a tool call actually happens. Both are optional and injected, so a
 * caller that wants neither gets exactly the pre-Phase-13 behaviour:
 *
 *   hooks       `PreToolUse` before a call (a deny blocks it, `updatedInput`
 *               rewrites what the tool receives, `ask` goes to the Phase 11
 *               consent prompt), `PostToolUse`/`PostToolUseFailure` after one,
 *               `SessionStart`/`Stop` around the turn.
 *   checkpoints a snapshot of the target file before every MUTATING_TOOLS call.
 *
 * The decision precedence, the fail-closed rule and the timeout policy all live
 * in `decideFromHooks`; the loop never re-ranks verdicts itself. Likewise
 * `MUTATING_TOOLS` and `createCheckpointFromTool` decide what is snapshotted and
 * how a path is confined, so the loop holds no second list of its own.
 *
 * ## Turn index
 *
 * `turnIndex` is the 1-based position of a message in the transcript, and it is
 * what every checkpoint is tagged with. That is not the loop's model-turn
 * counter: one model turn emits several messages (an assistant message with N
 * tool calls, then N tool results), so a model-turn number drifts away from the
 * message positions the moment a turn covers more than one message. Message
 * positions are what `restoreMessagesToTurn` and `forkSession` slice on, so
 * tagging snapshots with them is what makes checkpoint, rewind and fork line up.
 * The transcript is never reordered or spliced by the wiring, so a message's
 * position here is exactly its position in the saved session.
 */

import { DEFAULT_TOKEN_BUDGET, trimToBudget } from "./budget.js";
import { compactIfNeeded } from "./compact.js";
import { createCheckpointFromTool } from "../checkpoint/create.js";
import { decideFromHooks } from "../hooks/decide.js";
import { buildPayload } from "../hooks/run.js";
import { DEFAULT_TIMEOUTS } from "../hooks/types.js";
import { askOnTty, sanitizeForDisplay, SessionGrants } from "../permissions/ask.js";
import { MUTATING_TOOLS } from "../permissions/rules.js";
import type { HookChainResult } from "../hooks/decide.js";
import type { HookEvent } from "../hooks/events.js";
import type { HookGroup, HookPayload, HookTimeouts, ValidatedHookEntry } from "../hooks/types.js";
import type { McpClient } from "../mcp/client.js";
import type { Decision, PermissionMode, PermissionOutcome, PermissionRequest } from "../permissions/types.js";
import type { ToolContext } from "../tools/types.js";
import type { Session } from "./session.js";
import type {
  ChatMessage,
  ChatRequest,
  ResolvedModel,
  ToolCall,
  ToolDef,
  Usage,
} from "../providers/types.js";

export const DEFAULT_MAX_TURNS = 20;

/** Character caps on hook-supplied text, so one handler cannot flood context. */
const MAX_HOOK_CONTEXT = 2_000;
const MAX_HOOK_MESSAGE = 500;

export const DEFAULT_SYSTEM_PROMPT =
  "You are J.A.A., a local-first, multi-provider terminal coding agent. " +
  "Be concise, precise, and show only what is needed.";

export interface ToolExecutor {
  (call: ToolCall): Promise<string>;
}

/** What whoever answers a hook `ask` is told. */
export interface HookAskContext {
  /** The call as it would run, i.e. after any `updatedInput` rewrite. */
  call: ToolCall;
  /** The arguments parsed from `call.arguments`. */
  args: Record<string, unknown>;
  /** Why the chain resolved to `ask`. */
  reason: string;
  cwd: string;
  root: string;
}

/**
 * Answers a hook `ask`. Returning `allow` runs the call, anything else does not.
 *
 * Defaults to `askOnTty` — the same Phase 11 consent prompt `jaa ask` and
 * `jaa chat` already use for a permission `ask`, including its control-character
 * stripping and its fail-closed behaviour on EOF or interrupt. There is no
 * second prompt in the loop.
 */
export type HookAsk = (context: HookAskContext) => Promise<Decision>;

/** Runs every group registered for one event. Defaults to `decideFromHooks`. */
export type HookChainRunner = (
  event: HookEvent,
  groups: HookGroup[],
  payload: HookPayload,
) => Promise<HookChainResult>;

/** Records a checkpoint for one tool call. */
export type CheckpointRecorder = (
  toolName: string,
  toolCallId: string,
  turn: number,
  ctx: ToolContext,
  args: unknown,
) => Promise<void>;

export interface AgentLoopHookOptions {
  /** Validated hook entries, typically `loadAllHooks(...).entries`. */
  entries?: ValidatedHookEntry[];
  /** Connected MCP servers a `mcp` handler may call. */
  mcpClients?: McpClient[];
  /** Per-handler deadlines. Defaults to `DEFAULT_TIMEOUTS`. */
  timeouts?: HookTimeouts;
  /** `sessionId` in every payload. Defaults to `"jaa"`. */
  sessionId?: string;
  /** `cwd` in every payload. Defaults to `process.cwd()`. */
  cwd?: string;
  /** The root a `PermissionRequest` is evaluated against. Defaults to `cwd`. */
  root?: string;
  /** Reported as `permissionMode`; also informational for the hook itself. */
  permissionMode?: PermissionMode;
  /** Answers a hook `ask`. Defaults to the Phase 11 TTY prompt. */
  ask?: HookAsk;
  /** Replaces the chain runner wholesale; used by tests. */
  runChain?: HookChainRunner;
}

export interface AgentLoopCheckpointOptions {
  /** The session the snapshots belong to; its id names the store directory. */
  session: Session;
  /** Root and cwd every snapshot path is confined to. */
  ctx: ToolContext;
  /** Replaces the recorder; used by tests. Defaults to `createCheckpointFromTool`. */
  record?: CheckpointRecorder;
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
  /** Fired for a hook `systemMessage` — the operator-facing channel. */
  onHookMessage?: (message: string) => void;
  /** Phase 13 hook wiring. Omit it and no hook is ever fired. */
  hooks?: AgentLoopHookOptions;
  /** Phase 14 checkpoint wiring. Omit it and nothing is snapshotted. */
  checkpoints?: AgentLoopCheckpointOptions;
  /**
   * Phase 16 compaction. Omit it and the loop behaves exactly as before,
   * trimming to budget and dropping what does not fit.
   *
   * Compaction runs on the **request**, never on `history`. See the module
   * comment in `compact.ts`: rewriting `history` in place would shift every
   * message position after the compaction point, and Phase 14 checkpoints are
   * tagged with exactly those positions, so a checkpoint taken before a
   * compaction would resolve to a different message after it. `turnIndex` and
   * the saved session would then disagree with what actually ran.
   */
  compaction?: AgentLoopCompactionOptions;
  /** Fired when a compaction happened, for the operator-facing line. */
  onCompaction?: (info: CompactionNotice) => void;
}

export interface AgentLoopCompactionOptions {
  /** Fraction of the token budget at which compaction fires. Default 0.9. */
  threshold?: number;
  /** Chunks preserved verbatim at the tail. Default 6. */
  keepRecent?: number;
  /** 1-based message positions to preserve verbatim. */
  pinned?: readonly number[];
  /** Steer the summary. */
  focus?: string;
  /** Replaces the summariser. Used by tests. */
  summarize?: (transcript: string, focus: string | undefined) => Promise<string>;
}

export interface CompactionNotice {
  tokensBefore: number;
  tokensAfter: number;
  /** Model calls the summary cost. */
  calls: number;
}

export type StopReason = "completed" | "max_turns";

export interface AgentLoopResult {
  /** Full transcript (untrimmed) — assistant + tool messages in order. */
  messages: ChatMessage[];
  stopReason: StopReason;
  turns: number;
  /**
   * The next 1-based message position, i.e. the turn index the next checkpoint
   * will carry. Equal to `messages.length`; `turns` is a different number and
   * counts model turns only. Optional because several modules synthesise a
   * result without running the loop — the loop itself always sets it.
   */
  turnIndex?: number;
  /** Cumulative usage across every request sent. */
  usage: Usage;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const hooks = options.hooks === undefined ? null : createHookWiring(options.hooks, options.onHookMessage);
  const checkpoints = options.checkpoints === undefined ? null : createCheckpointRecorder(options.checkpoints);

  // `SessionStart`/`Stop` bracket one loop invocation, which is one turn from
  // the operator's point of view. A provider that throws is not the end of a
  // turn, so neither fires and the original error reaches the caller unchanged.
  if (hooks !== null) await hooks.start();
  const result = await drive(options, hooks, checkpoints);
  if (hooks !== null) await hooks.stop();
  return result;
}

async function drive(
  options: AgentLoopOptions,
  hooks: HookWiring | null,
  checkpoints: BoundRecorder | null,
): Promise<AgentLoopResult> {
  const turns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const history: ChatMessage[] = [...options.messages];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 1; turn <= turns; turn++) {
    // Phase 16: summarise before trimming, and over the **full history**. A
    // summary preserves what the conversation was about; a trim preserves only
    // what happened recently. On a long session that is the difference between
    // an agent that knows the task and one that has forgotten it.
    //
    // The order is load-bearing. `compactIfNeeded` refuses when trimming would
    // not drop a message, so handing it an already-trimmed request made every
    // compaction a silent no-op. The trim stays, as the final guarantee that a
    // request fits the window even with compaction off.
    const request: ChatRequest = {
      model: options.model.model,
      messages: trimToBudget(history, budget),
    };
    if (options.compaction !== undefined) {
      const compacted = await compactIfNeeded(
        history,
        {
          ...(options.compaction.threshold !== undefined ? { threshold: options.compaction.threshold } : {}),
          budget,
          ...(options.compaction.keepRecent !== undefined ? { keepRecent: options.compaction.keepRecent } : {}),
          ...(options.compaction.pinned !== undefined ? { pinned: options.compaction.pinned } : {}),
          ...(options.compaction.focus !== undefined ? { focus: options.compaction.focus } : {}),
          ...(options.compaction.summarize !== undefined ? { summarize: options.compaction.summarize } : {}),
        },
        options.model,
      );
    if (compacted.compacted) {
      request.messages = trimToBudget(compacted.messages, budget);
      options.onCompaction?.({
          tokensBefore: compacted.tokensBefore,
          tokensAfter: compacted.tokensAfter,
          calls: compacted.calls,
        });
      }
    }
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

      // The position of the assistant message that proposed this call. Every
      // snapshot taken here is tagged with it, so restoring to turn N keeps the
      // first N messages and undoes exactly the writes made after them.
      const turnIndex = history.length;

      const pre = hooks === null ? { allowed: true as const, call } : await hooks.preToolUse(call);
      if (!pre.allowed) {
        // The tool never ran, so there is nothing to snapshot and no post event
        // to fire: the model is told why, and can propose something else.
        const denial = denialResult(call.name, pre.reason);
        options.onToolResult?.(pre.call, denial, false);
        history.push({ role: "tool", content: denial, toolCallId: call.id });
        continue;
      }

      if (checkpoints !== null && MUTATING_TOOLS.includes(pre.call.name)) {
        // `MUTATING_TOOLS` is the permission engine's own list, read rather than
        // copied: a snapshot is taken for exactly the calls that can change the
        // tree, and the two can never disagree about which those are.
        await checkpoints(pre.call.name, pre.call.id, turnIndex, parseToolArgs(pre.call.arguments));
      }

      let result: string;
      let ok = true;
      try {
        result = await options.executeTool(pre.call);
      } catch (err) {
        ok = false;
        result = `tool "${pre.call.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      const post = hooks === null ? { result } : await hooks.postToolUse(pre.call, result, ok);
      const final =
        pre.additionalContext === undefined ? post.result : appendHookContext(post.result, pre.additionalContext);

      options.onToolResult?.(pre.call, final, ok);
      history.push({ role: "tool", content: final, toolCallId: call.id });
    }
  }

  return {
    messages: history,
    stopReason: "max_turns",
    turns,
    turnIndex: history.length,
    usage: { inputTokens, outputTokens },
  };
}

function complete(
  messages: ChatMessage[],
  turns: number,
  inputTokens: number,
  outputTokens: number,
): AgentLoopResult {
  return { messages, stopReason: "completed", turns, turnIndex: messages.length, usage: { inputTokens, outputTokens } };
}

// --- checkpoints -----------------------------------------------------------

/** A recorder with the session and the confined root already bound to it. */
type BoundRecorder = (toolName: string, toolCallId: string, turn: number, args: unknown) => Promise<void>;

function createCheckpointRecorder(options: AgentLoopCheckpointOptions): BoundRecorder {
  const record =
    options.record ??
    ((toolName, toolCallId, turn, ctx, args) =>
      createCheckpointFromTool(options.session, toolName, toolCallId, turn, ctx, args));
  return async (toolName, toolCallId, turn, args) => {
    try {
      await record(toolName, toolCallId, turn, options.ctx, args);
    } catch {
      // A snapshot is a safety net taken *before* a tool runs. Failing to take
      // one must never be the reason the call it protects does not happen.
    }
  };
}

// --- hooks -----------------------------------------------------------------

/** What `PreToolUse` resolved to. */
interface PreToolVerdict {
  /** False when a hook or the operator refused the call. */
  allowed: boolean;
  /** The call the tool actually receives: `updatedInput` applied. */
  call: ToolCall;
  /** Context a hook asked to add to the conversation. */
  additionalContext?: string;
  /** Why the call was refused. Only meaningful when `allowed` is false. */
  reason?: string;
}

/** What `PostToolUse` left of the tool's result. */
interface PostToolOutcome {
  result: string;
}

interface HookWiring {
  start(): Promise<void>;
  stop(): Promise<void>;
  preToolUse(call: ToolCall): Promise<PreToolVerdict>;
  postToolUse(call: ToolCall, result: string, ok: boolean): Promise<PostToolOutcome>;
}

/**
 * The loop's view of the hook chain.
 *
 * Thin on purpose: it builds payloads, hands them to the chain runner, and
 * applies what comes back. Every judgement — precedence, the fail-closed rule
 * on a crash or a timeout, the `if` filter, per-handler deadlines — belongs to
 * `decideFromHooks`, which is already tested for all of it.
 */
function createHookWiring(options: AgentLoopHookOptions, notify: ((message: string) => void) | undefined): HookWiring {
  const entries = options.entries ?? [];
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const mcpClients = options.mcpClients ?? [];
  const sessionId = options.sessionId ?? "jaa";
  const cwd = options.cwd ?? process.cwd();
  const root = options.root ?? cwd;
  const grants = new SessionGrants();
  const ask =
    options.ask ??
    ((context: HookAskContext) => askOnTty(askRequest(context), askOutcome(context), grants));
  const runChain: HookChainRunner =
    options.runChain ?? ((event, groups, payload) => decideFromHooks(event, groups, payload, timeouts, mcpClients));

  function groupsFor(event: HookEvent): HookGroup[] {
    return entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups);
  }

  function basePayload(): Partial<HookPayload> {
    return {
      sessionId,
      cwd,
      ...(options.permissionMode !== undefined ? { permissionMode: options.permissionMode } : {}),
    };
  }

  function toolPayload(event: HookEvent, call: ToolCall, toolResponse?: string): HookPayload {
    return buildPayload(event, {
      ...basePayload(),
      toolName: call.name,
      toolInput: parseToolArgs(call.arguments),
      toolCallId: call.id,
      ...(toolResponse !== undefined ? { toolResponse } : {}),
    });
  }

  async function fire(event: HookEvent, extra: Partial<HookPayload> = {}): Promise<HookChainResult | undefined> {
    const groups = groupsFor(event);
    if (groups.length === 0) return undefined;
    const chain = await runChain(event, groups, buildPayload(event, { ...basePayload(), ...extra }));
    // A `systemMessage` is the operator's channel, so it is surfaced rather than
    // pushed into the transcript: sending it to the provider would leak
    // user-facing text, and inserting a message would move every later message
    // one position along, which is exactly the drift the turn index avoids.
    if (chain.systemMessage !== undefined) notify?.(sanitizeForDisplay(chain.systemMessage, MAX_HOOK_MESSAGE));
    return chain;
  }

  return {
    async start() {
      await fire("SessionStart");
    },

    async stop() {
      // `Stop` is not a blocking event, so a verdict on it has nothing to block;
      // only the message is worth surfacing.
      await fire("Stop");
    },

    async preToolUse(call: ToolCall): Promise<PreToolVerdict> {
      const groups = groupsFor("PreToolUse");
      if (groups.length === 0) return { allowed: true, call };

      const chain = await runChain("PreToolUse", groups, toolPayload("PreToolUse", call));
      const effective = withRewrittenInput(call, chain.updatedInput);

      if (chain.decision === "deny") {
        return { allowed: false, call: effective, reason: `a PreToolUse hook denied it: ${chain.reason ?? "no reason given"}` };
      }

      if (chain.decision === "ask") {
        const reason = chain.reason ?? "a PreToolUse hook asked for confirmation";
        const answer = await ask({
          call: effective,
          args: parseToolArgs(effective.arguments),
          reason,
          cwd,
          root,
        });
        if (answer === "allow") {
          // Fall through: the call runs with whatever the chain rewrote.
        } else if (answer === "defer") {
          return { allowed: false, call: effective, reason: `a PreToolUse hook deferred the call: ${reason}` };
        } else {
          return {
            allowed: false,
            call: effective,
            reason: `permission denied by user, which a PreToolUse hook asked about: ${reason}`,
          };
        }
      }

      return {
        allowed: true,
        call: effective,
        ...(chain.additionalContext !== undefined ? { additionalContext: chain.additionalContext } : {}),
      };
    },

    async postToolUse(call: ToolCall, result: string, ok: boolean): Promise<PostToolOutcome> {
      // A failing call fires `PostToolUseFailure`; a succeeding one
      // `PostToolUse`. Both are post events: neither can un-run the tool.
      const event: HookEvent = ok ? "PostToolUse" : "PostToolUseFailure";
      const groups = groupsFor(event);
      if (groups.length === 0) return { result };

      const chain = await runChain(event, groups, toolPayload(event, call, result));
      if (chain.systemMessage !== undefined) notify?.(sanitizeForDisplay(chain.systemMessage, MAX_HOOK_MESSAGE));

      if (chain.decision === "deny") {
        // The tool ran, but the operator's hook will not stand for what it
        // produced. Withholding it from the transcript is the only enforcement
        // left, so the model is told the output was rejected rather than being
        // handed the text anyway.
        return { result: `hook rejected the output of ${call.name}: ${chain.reason ?? "no reason given"}` };
      }

      let text = result;
      // On a post event there are no arguments left to replace, so the rewrite
      // field carries the replacement result. A handler that sends a bare
      // string means that string; anything else is read as JSON.
      if (chain.updatedInput !== undefined) text = rewrittenResult(chain.updatedInput);
      if (chain.additionalContext !== undefined) text = appendHookContext(text, chain.additionalContext);
      return { result: text };
    },
  };
}

/**
 * The Phase 11 request shape for a hook `ask`, so the existing consent prompt
 * renders it exactly as it renders any other gated call.
 */
function askRequest(context: HookAskContext): PermissionRequest {
  return { tool: context.call.name, args: context.args, cwd: context.cwd, root: context.root };
}

function askOutcome(context: HookAskContext): PermissionOutcome {
  return { decision: "ask", reason: context.reason, specificity: -1 };
}

/** The call the tool receives once `updatedInput` has been applied. */
function withRewrittenInput(call: ToolCall, updated: Record<string, unknown> | undefined): ToolCall {
  if (updated === undefined) return call;
  return { id: call.id, name: call.name, arguments: JSON.stringify(updated) };
}

function rewrittenResult(updated: unknown): string {
  return typeof updated === "string" ? updated : JSON.stringify(updated);
}

/**
 * Attach a hook's `additionalContext` to the tool result.
 *
 * It has to ride on the result rather than become a message of its own: a
 * provider requires every tool result to immediately follow the assistant
 * message that proposed the call, and a standalone system message in that gap
 * is a malformed request. It also keeps message positions fixed, so the turn
 * index a checkpoint carries still addresses the message the operator sees.
 */
function appendHookContext(result: string, context: string): string {
  return `${result}\n\n[hook] ${sanitizeForDisplay(context, MAX_HOOK_CONTEXT)}`;
}

function denialResult(toolName: string, reason: string | undefined): string {
  return `hook denied ${toolName}: ${reason ?? "no reason given"}`;
}

/**
 * A tool call's arguments as an object.
 *
 * Malformed JSON yields `{}` rather than a throw, exactly as the permission gate
 * does it: the arguments are facts to match rules on, and the tool itself
 * reports a bad payload as its own error.
 */
function parseToolArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Not JSON. Fall through to no facts.
  }
  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
