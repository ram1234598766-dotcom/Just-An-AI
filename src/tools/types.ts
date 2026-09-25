import type { z } from "zod";
import type { ToolDef } from "../providers/types.js";

/**
 * What tools need to know about the world at execution time. Everything is
 * injected per invocation — the registry itself is context-free, so the same
 * registry backs `jaa ask`, the Phase 5 TUI, and tests.
 */
export interface ToolContext {
  /** Workspace root — no tool may read or write outside of it. */
  root: string;
  /** Default working directory for relative paths (usually == root). */
  cwd: string;
  /** Whether the bash tool may actually execute commands. */
  allowBash: boolean;
  /**
   * Whether a command that needs a shell must also be OS-sandboxed.
   * `"require"` (the default) refuses the command on a host that cannot
   * sandbox; `"best-effort"` runs it and reports the degradation on stderr.
   */
  sandboxEnforcement?: "require" | "best-effort";
  /** Whether sandboxed commands may reach the network. Default: no. */
  allowNetwork?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Provider-neutral JSON Schema for advertising to the model. */
  inputSchema: ToolDef["inputSchema"];
  /** Runtime validator — every tool route's arguments through this. */
  schema: z.ZodType<unknown>;
  /**
   * Runs the tool. `input` has already passed `schema.safeParse`; throw to
   * signal failure (the loop turns throws into tool-error results).
   */
  run(input: unknown, ctx: ToolContext): Promise<string>;
}