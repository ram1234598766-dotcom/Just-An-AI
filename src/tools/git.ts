import { z } from "zod";
import { GIT_CONFIG, GIT_ENV_ALLOWLIST, baseGitEnv } from "./gitEnv.js";
import { runProcess } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * Read-only git operations, all run with `-C <root>` so a repo can never be
 * touched outside the workspace. No tool here can mutate history or push.
 */
const GIT = "git";

/**
 * The variables the sandbox wrapper forwards to the git child.
 *
 * The same list {@link baseGitEnv} hands `runProcess`, deliberately: bubblewrap
 * starts the child from `--clearenv` and re-adds only what `envPassthrough`
 * names, read from its own environment. A name the two lists disagree about is
 * a name that silently vanishes for the *inner* git on a Linux host while still
 * working on a Windows one — the kind of difference that only shows up in
 * production, on the other platform.
 *
 * Exported so a test can read the list the call site actually uses rather than a
 * copy of it, and so that "no credential-shaped name is in here" is a checked
 * property rather than a comment. The auth variables reach git through
 * `runProcess`'s `env` field and must never be added here: a sandbox
 * passthrough is a *name* read out of the parent environment, and the token is
 * a value jaa put in the child deliberately.
 */
export const GIT_SANDBOX_ENV_PASSTHROUGH: readonly string[] = GIT_ENV_ALLOWLIST;

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
      // An explicit environment, not an omitted one. Omitted means "inherit
      // everything", and on a host with no sandbox — which is every Windows
      // host, and Windows has no sandbox mechanism to install — that is the
      // whole boundary: a `GITHUB_TOKEN` in the operator's shell reaches this
      // child today with no code having asked for it.
      //
      // `baseGitEnv` and nothing more. These four subcommands run `status`,
      // `log`, `diff` and `show` against the local repository and contact no
      // remote, so a token on them would be pure exposure: there is no
      // authentication for them to perform. A git invocation that does reach a
      // remote is `gitRemoteEnv`'s job, in `src/skills/install.ts`.
      env: baseGitEnv(),
      // The argv here is fixed and jaa-controlled, unlike `bash`, so a host with
      // no OS sandbox still gets a usable (hardened) tool rather than a refusal.
      // Residual risk is a hostile git config we have not thought of, which is
      // why `git_diff` is not treated as read-only in the permission engine.
      sandbox: {
        writableRoots: [ctx.root],
        readableRoots: [ctx.root],
        network: false,
        envPassthrough: [...GIT_SANDBOX_ENV_PASSTHROUGH],
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