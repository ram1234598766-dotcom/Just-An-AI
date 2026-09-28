import type { AgentSpec, ParsedAgents } from "./types.js";
import { runAgentLoop, DEFAULT_SYSTEM_PROMPT, type AgentLoopResult } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { resolveModel } from "../providers/router.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import type { SandboxEnforcement } from "../sandbox/types.js";
import type { ValidatedHookEntry } from "../hooks/types.js";
import type { PermissionMode } from "../permissions/types.js";
import type { Session } from "../agent/session.js";

export interface SubagentOptions {
  /** The task to give the subagent. */
  task: string;
  /** Optional user prompt override (defaults to the agent's instructions). */
  prompt?: string;
  /** Model to use. */
  model?: { provider?: string; model?: string };
  /** Tool visibility — defaults to true. */
  tools?: boolean;
  /** Bash access — defaults to false (subagents run without shell by default). */
  allowBash?: boolean;
  /**
   * How hard to try to confine shell commands. `require` refuses when no OS
   * sandbox exists; `best-effort` runs unisolated with a visible warning.
   * Unset means `require`, so the safe default is preserved for library callers.
   */
  sandboxEnforcement?: SandboxEnforcement;
  /** Whether a confined shell command may reach the network. Defaults to false. */
  allowNetwork?: boolean;
  /** Max turns for this subagent run. */
  maxTurns?: number;
  /** Token budget for context trimming. */
  tokenBudget?: number;
  /** Sampling temperature. */
  temperature?: number;
  /** Provider context window override (e.g. ollama num_ctx). */
  numContext?: number;
  /** Render callback for each assistant message produced by the subagent. */
  onAssistantMessage?: (msg: ChatMessage) => void;
  /** Render callback for each tool result. */
  onToolResult?: (call: ToolCall, result: string, ok: boolean) => void;
  /** Workspace root for path confinement. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Wrap the subagent's tool executor, e.g. with the permission gate. A
   * subagent can otherwise reach anything the parent session allows.
   */
  executeTool?: (
    inner: (call: ToolCall) => Promise<string>,
  ) => (call: ToolCall) => Promise<string>;
  /**
   * Phase 13: the validated hook entries a subagent's tool calls are gated by.
   *
   * Omitted — or empty — and no hook is ever fired, which leaves the pre-Phase-13
   * path unchanged, so a caller that knows nothing about hooks needs to do
   * nothing. `jaa ask` and `jaa chat` pass the same `loadAllHooks(...).entries`
   * they pass to their own loop, so a `PreToolUse` rule that blocks a tool in the
   * parent blocks it in the subagent too: a subagent is not a way around a hook.
   *
   * Deliberately not defaulted here. Wiring the chain for every caller would fire
   * `SessionStart`/`Stop` around the `agent` hook handler's own one-shot
   * subagent, and would recurse through it; the call site decides instead.
   */
  hookEntries?: ValidatedHookEntry[];
  /** `sessionId` in every hook payload. Defaults to the loop's own `"jaa"`. */
  hookSessionId?: string;
  /** The permission mode the subagent's tool calls are actually gated under. */
  permissionMode?: PermissionMode;
  /**
   * Phase 14: the session a subagent's file snapshots belong to. Its id names the
   * `~/.jaa/checkpoints/<id>/` store, so without it there is nowhere to snapshot
   * to and `jaa rewind` cannot reach a subagent's writes.
   *
   * The confined root is taken from this run's own `toolContext`, not from the
   * caller: a snapshot is only ever taken for a path the subagent's tools are
   * already confined to, so it cannot become a way to read outside the root the
   * writes are limited to.
   */
  checkpointSession?: Session;
}

export interface SubagentResult extends AgentLoopResult {
  /** The spec of the subagent that ran. */
  spec: AgentSpec;
}

/**
 * Construct a system prompt for a subagent by combining the project context
 * and the agent's own instructions.  The subagent inherits the default jaa
 * identity but is scoped to its specialised instructions.
 */
export function buildAgentSystemPrompt(projectContext: string, spec: AgentSpec): string {
  const parts: string[] = [];
  if (projectContext) {
    parts.push(`## Project context\n\n${projectContext}`);
  }
  parts.push(`## Subagent: ${spec.name}\n\n${spec.instructions}`);
  parts.push(DEFAULT_SYSTEM_PROMPT);
  return parts.join("\n\n");
}

/**
 * Run a subagent defined in AGENTS.md.
 *
 * The subagent gets the combined project context + agent instructions as its
 * system prompt, its own tool registry (bash gated off by default), and the
 * provided task as its first user message.
 *
 * ## The safety posture does not move when hooks or checkpoints are wired in
 *
 * Neither of them grants anything. `hookEntries` and `checkpointSession` are
 * passed to the loop, which is the same pair `jaa ask` hands its own run, and the
 * loop applies them at fixed points that this module does not control:
 *
 *   - The registry and `toolContext` above are built before either is wired, so
 *     `allowBash` stays whatever the caller said (default false) and
 *     `sandboxEnforcement` stays `require`. Nothing here can widen them.
 *   - A snapshot only reads a file the call is about to write, through the same
 *     `confinePath` and `MUTATING_TOOLS` list `ask` uses, and only for a tool
 *     whose own schema names a single `path` — so `bash` and `git_diff` still
 *     snapshot nothing, and no command is executed to take one.
 *   - A `PreToolUse` deny is resolved by the loop *before* the call reaches
 *     `executeTool`, which is where this module's permission-gate wrapper and the
 *     registry both sit. So a denied call never reaches the gate, never reaches a
 *     tool, and is not snapshotted on the way.
 */
export async function runSubagent(
  agents: ParsedAgents,
  spec: AgentSpec,
  opts: SubagentOptions,
): Promise<SubagentResult> {
  const model = resolveModel(opts.model ?? {});
  const systemPrompt = opts.prompt ?? buildAgentSystemPrompt(agents.projectContext, spec);

  const registry = createDefaultRegistry();
  const toolContext: ToolContext = {
    root: opts.cwd ?? process.cwd(),
    cwd: opts.cwd ?? process.cwd(),
    allowBash: opts.allowBash ?? false,
    // Without this, a subagent's `bash` defaults to `require` and can never be
    // satisfied on a host with no OS sandbox -- the call would fail with no way
    // for the operator to say so. Plumbed from the CLI's `--no-sandbox`.
    ...(opts.sandboxEnforcement !== undefined ? { sandboxEnforcement: opts.sandboxEnforcement } : {}),
    ...(opts.allowNetwork !== undefined ? { allowNetwork: opts.allowNetwork } : {}),
  };
  const rawExecute = (call: ToolCall) => registry.execute(call.name, call.arguments, toolContext);
  // Callers can wrap this with the permission gate. Left ungated, a subagent
  // is a way to reach every tool the parent can, minus whatever the caller
  // remembered to disable.
  const executeTool = opts.executeTool ? opts.executeTool(rawExecute) : rawExecute;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: opts.task },
  ];

  const hookEntries = opts.hookEntries ?? [];

  const loopOptions: Parameters<typeof runAgentLoop>[0] = {
    model,
    messages,
    executeTool,
    ...(opts.tools !== false ? { tools: registry.list() } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.numContext !== undefined ? { numContext: opts.numContext } : {}),
    ...(opts.onAssistantMessage !== undefined ? { onAssistantMessage: opts.onAssistantMessage } : {}),
    ...(opts.onToolResult !== undefined ? { onToolResult: opts.onToolResult } : {}),
    // Phase 13: omitted entirely when no layer declares a hook, which is the same
    // rule `ask` and `chat` follow — so a host with no hooks keeps the loop's
    // no-wiring path and no `SessionStart`/`Stop` round trip.
    ...(hookEntries.length > 0
      ? {
          hooks: {
            entries: hookEntries,
            // The real session and the real workspace, not the loop's placeholders.
            ...(opts.hookSessionId !== undefined ? { sessionId: opts.hookSessionId } : {}),
            cwd: toolContext.cwd,
            root: toolContext.root,
            // The policy the call was gated under, so a handler sees the mode that
            // actually decided it rather than no mode at all.
            ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
          },
        }
      : {}),
    // Phase 14: snapshots into the session the caller named, confined to this
    // run's own root. With no mutating tool call, nothing is written.
    ...(opts.checkpointSession !== undefined
      ? { checkpoints: { session: opts.checkpointSession, ctx: toolContext } }
      : {}),
  };

  const loopResult = await runAgentLoop(loopOptions);

  return { ...loopResult, spec };
}
