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
}

/** Parsed AGENTS.md: top-level project context + subagent specs. */
export interface ParsedAgents {
  /** Everything before the `## Subagents` heading. */
  projectContext: string;
  /** Subagent definitions in order of appearance. */
  subagents: AgentSpec[];
}
