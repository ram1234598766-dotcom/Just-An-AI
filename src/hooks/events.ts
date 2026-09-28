/**
 * Hook events — the lifecycle vocabulary jaa fires.
 *
 * The names and payloads mirror Claude Code's hooks API so a config written
 * for one works in the other. Events are grouped by cadence:
 *
 *   per-session  SessionStart, SessionEnd, ConfigChange
 *   per-turn     UserPromptSubmit, Stop, StopFailure, PreCompact, PostCompact
 *   per-tool     PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch,
 *                PermissionRequest, Notification
 *   per-agent    SubagentStart, SubagentStop
 */

export const HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "PreCompact",
  "PostCompact",
  "ConfigChange",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events that may block or rewrite a tool call. */
export const BLOCKING_EVENTS: readonly HookEvent[] = ["PreToolUse", "PermissionRequest"];

/** Events that fire after a tool runs and may rewrite its result. */
export const POST_EVENTS: readonly HookEvent[] = ["PostToolUse", "PostToolUseFailure"];

/** Events that fire before the agent loop starts a turn. */
export const PRE_TURN_EVENTS: readonly HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreCompact"];

/** Events that fire after the agent loop finishes a turn. */
export const POST_TURN_EVENTS: readonly HookEvent[] = [
  "Stop",
  "StopFailure",
  "PostCompact",
  "SessionEnd",
  "SubagentStop",
];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}