import { join } from "node:path";
import { z } from "zod";
import { runProcess } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const bashSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

/**
 * Shell execution behind an explicit user gate: unless `ctx.allowBash` the tool
 * refuses and tells the model how to unlock it. This is the "ask" in bash
 * safe/ask — the agent can never run commands the operator did not approve.
 */
async function bashTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { command, timeoutMs } = bashSchema.parse(args);
  if (!ctx.allowBash) {
    return `shell disabled — run with --ask bash (or --approve) to allow commands. Not executed: ${command}`;
  }

  const result = await runProcess(
    process.platform === "win32" ? "cmd.exe" : "sh",
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
    { cwd: ctx.cwd, timeoutMs },
  );

  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  if (result.code !== 0 && parts.length === 0) parts.push(`(exit code ${String(result.code)})`);
  const body = parts.join("\n");
  return `${body}${body.endsWith("\n") ? "" : "\n"}[exit ${String(result.code)} in ${join(ctx.cwd)}]`.trim();
}

export const bashTools: ToolDefinition[] = [
  {
    name: "bash",
    description:
      "Run a shell command in the workspace. Always blocked unless the operator approved shell use.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "shell command to run" },
        timeoutMs: { type: "integer", description: "timeout in ms (default 30000, max 120000)" },
      },
      required: ["command"],
    },
    schema: bashSchema,
    run: bashTool,
  },
];