import { z } from "zod";
import { runProcess } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * Read-only git operations, all run with `-C <root>` so a repo can never be
 * touched outside the workspace. No tool here can mutate history or push.
 */
const GIT = "git";

const gitLogSchema = z.object({ n: z.number().int().min(1).max(50).default(10) });
const gitDiffSchema = z.object({ staged: z.boolean().default(false) });
const gitShowSchema = z.object({ path: z.string().min(1) });

async function runGit(ctx: ToolContext, args: string[], timeoutMs = 30_000): Promise<string> {
  const result = await runProcess(GIT, ["-C", ctx.root, ...args], { cwd: ctx.root, timeoutMs });
  const parts = [result.stdout, result.stderr].filter((s) => s.length > 0);
  const body = parts.join("\n");
  return `${body}${body.endsWith("\n") ? "" : "\n"}[exit ${String(result.code)}]`.trim();
}

async function logTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { n } = gitLogSchema.parse(args);
  return runGit(ctx, ["--no-pager", "log", "--oneline", `-n${n}`]);
}

async function statusTool(_args: unknown, ctx: ToolContext): Promise<string> {
  return runGit(ctx, ["--no-pager", "status", "--short"]);
}

async function diffTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { staged } = gitDiffSchema.parse(args);
  return runGit(ctx, ["--no-pager", "diff", ...(staged ? ["--cached"] : [])]);
}

async function showTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path } = gitShowSchema.parse(args);
  return runGit(ctx, ["--no-pager", "show", `HEAD:${path}`]);
}

export const gitTools: ToolDefinition[] = [
  {
    name: "git_status",
    description: "Working tree status (read-only, short format).",
    inputSchema: { type: "object", properties: {} },
    schema: z.object({}),
    run: statusTool,
  },
  {
    name: "git_log",
    description: "Recent commit history, one line each (read-only).",
    inputSchema: {
      type: "object",
      properties: { n: { type: "integer", description: "number of commits (default 10)" } },
    },
    schema: gitLogSchema,
    run: logTool,
  },
  {
    name: "git_diff",
    description: "Show uncommitted changes to tracked files (read-only).",
    inputSchema: {
      type: "object",
      properties: { staged: { type: "boolean", description: "show staged diff instead" } },
    },
    schema: gitDiffSchema,
    run: diffTool,
  },
  {
    name: "git_show",
    description: "Print a file's committed content at HEAD (read-only).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "path relative to the git root" } },
      required: ["path"],
    },
    schema: gitShowSchema,
    run: showTool,
  },
];