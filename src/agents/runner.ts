import type { AgentSpec, ParsedAgents } from "./types.js";
import { runAgentLoop, DEFAULT_SYSTEM_PROMPT, type AgentLoopResult } from "../agent/loop.js";
import { createDefaultRegistry } from "../tools/index.js";
import { resolveModel } from "../providers/router.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";

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
  };

  const loopResult = await runAgentLoop(loopOptions);

  return { ...loopResult, spec };
}
