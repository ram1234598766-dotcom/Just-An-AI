import { join } from "node:path";
import { z } from "zod";
import { runProcess } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const bashSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
});

/**
 * Shell execution behind two explicit gates.
 *
 * 1. `ctx.allowBash` — the operator must have allowed shell access at all.
 * 2. `ctx.sandboxEnforcement` — when the operator requires a sandbox, a host
 *    that cannot provide one refuses the command rather than running it wide.
 *
 * The command runs confined to the workspace, with outbound network off unless
 * the operator allowed it.
 */
async function bashTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { command, timeoutMs } = bashSchema.parse(args);
  if (!ctx.allowBash) {
    return `shell disabled — the operator did not allow shell access (rerun without --no-bash). Not executed: ${command}`;
  }

  const result = await runProcess(
    process.platform === "win32" ? "cmd.exe" : "sh",
    process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
    {
      cwd: ctx.cwd,
      timeoutMs,
      sandbox: {
        writableRoots: [ctx.root],
        readableRoots: [ctx.root],
        network: ctx.allowNetwork === true,
        envPassthrough: ["PATH", "HOME", "USERPROFILE", "LANG", "TMPDIR", "TEMP", "TMP", "SystemRoot", "COMSPEC"],
        enforcement: ctx.sandboxEnforcement ?? "require",
      },
    },
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
      "Run a shell command in the workspace. Gated: reports \"shell disabled\" when the operator ran with --no-bash.",
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