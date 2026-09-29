/**
 * Subagent specification — a named agent persona defined in AGENTS.md.
 */
export interface AgentSpec {
  /** Subagent name — the `### <name>` heading. */
  name: string;
  /** One-line description from the bullet field. */
  description: string;
  /** Glob patterns or file paths this agent owns. */
  ownership: string;
  /** Comma-separated names of agents this depends on, or "none". */
  deps: string;
  /** Acceptance criteria — what must be true when this agent finishes. */
  acceptance: string;
  /** System-prompt instructions that define this agent's persona/behaviour. */
  instructions: string;
  /**
   * Phase 15 execution controls. All optional and all narrowing.
   *
   * Every field here can only remove a capability from what the calling session
   * already has. None of them is read from a subagent's own output — they come
   * from AGENTS.md, which the operator wrote — and {@link effectiveToolNames} in
   * `src/orchestrator/pool.ts` is the only thing that turns `tools` and
   * `disallowedTools` into an actual set, as an intersection with the parent's.
   * That is the whole mechanism behind the phase gate's "a subagent cannot
   * escalate its own permissions": there is no field here that adds one.
   */
  /** Provider id or model id, or a space-separated `provider model` pair. */
  model?: string;
  /** Tool names or globs this agent may use. Omitted means "whatever the session has". */
  tools?: string;
  /** Tool names or globs this agent may never use. Applied after `tools`. */
  disallowedTools?: string;
  /** Skills preloaded into the system prompt, so the agent does not have to match them. */
  skills?: string;
  /** Cap on loop turns for this agent. */
  maxTurns?: number;
  /** `worktree` runs this agent in its own checkout. Requires a git repository. */
  isolation?: "none" | "worktree";
  /** Run detached from the parent turn. Requires the Phase 15 background runner. */
  background?: boolean;
}

/** Parsed AGENTS.md: top-level project context + subagent specs. */
export interface ParsedAgents {
  /** Everything before the `## Subagents` heading. */
  projectContext: string;
  /** Subagent definitions in order of appearance. */
  subagents: AgentSpec[];
}
