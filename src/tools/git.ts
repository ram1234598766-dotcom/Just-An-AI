import { z } from "zod";
import { runProcess } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * Read-only git operations, all run with `-C <root>` so a repo can never be
 * touched outside the workspace. No tool here can mutate history or push.
 */
const GIT = "git";

/**
 * Top-level git hardening: `-c` config overrides, which must appear BEFORE the
 * subcommand.
 *
 * `core.fsmonitor` matters as much as the rest: a repository-local
 * `[core] fsmonitor = /path/to/program` is executed by `git status` and
 * `git diff`, so without `-c core.fsmonitor=false` a `write_file` into
 * `.git/config` is code execution even with `--no-ext-diff` in place. Verified
 * on Linux with the exact argv below.
 */
const GIT_CONFIG = [
  "-c",
  "core.pager=cat",
  "-c",
  "core.hooksPath=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.external=",
  "-c",
  "credential.helper=",
  "-c",
  "protocol.ext.allow=never",
];

/**
 * Subcommand-level hardening. These are options of the *diff-producing*
 * subcommands only -- `git status` rejects them outright -- so they must be
 * applied per subcommand and placed AFTER it.
 *
 * `--no-ext-diff --no-textconv` close the `[diff "<driver>"] command` vector
 * selected by a `.gitattributes` `diff=<driver>` line. Both files are
 * agent-writable. Verified locally: without these flags git invokes the
 * repo-local driver.
 */
const DIFF_SUBCOMMAND_FLAGS = ["--no-ext-diff", "--no-textconv"];

const gitLogSchema = z.object({ n: z.number().int().min(1).max(50).default(10) });
const gitDiffSchema = z.object({ staged: z.boolean().default(false) });
const gitShowSchema = z.object({ path: z.string().min(1) });

async function runGit(
  ctx: ToolContext,
  subcommand: string,
  args: string[],
  subcommandFlags: string[] = DIFF_SUBCOMMAND_FLAGS,
  timeoutMs = 30_000,
): Promise<string> {
  const result = await runProcess(
    GIT,
    ["-C", ctx.root, ...GIT_CONFIG, subcommand, ...subcommandFlags, ...args],
    {
      cwd: ctx.root,
      timeoutMs,
      // The argv here is fixed and jaa-controlled, unlike `bash`, so a host with
      // no OS sandbox still gets a usable (hardened) tool rather than a refusal.
      // Residual risk is a hostile git config we have not thought of, which is
      // why `git_diff` is not treated as read-only in the permission engine.
      sandbox: {
        writableRoots: [ctx.root],
        readableRoots: [ctx.root],
        network: false,
        envPassthrough: ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP"],
        enforcement: "best-effort",
      },
    },
  );
  const parts = [result.stdout, result.stderr].filter((s) => s.length > 0);
  const body = parts.join("\n");
  return `${body}${body.endsWith("\n") ? "" : "\n"}[exit ${String(result.code)}]`.trim();
}

async function logTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { n } = gitLogSchema.parse(args);
  return runGit(ctx, "log", ["--oneline", `-n${n}`]);
}

async function statusTool(_args: unknown, ctx: ToolContext): Promise<string> {
  // `git status` takes no diff options, so the subcommand flags must be omitted
  // or it exits 128 with a usage error.
  return runGit(ctx, "status", ["--short"], []);
}

async function diffTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { staged } = gitDiffSchema.parse(args);
  return runGit(ctx, "diff", staged ? ["--cached"] : []);
}

async function showTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path } = gitShowSchema.parse(args);
  return runGit(ctx, "show", [`HEAD:${path}`]);
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