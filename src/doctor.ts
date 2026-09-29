import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasKey } from "./config/keyring.js";
import { providerStatuses } from "./config/providers.js";
import { jaaHome } from "./config/paths.js";
import { maskToken, redact } from "./config/redact.js";
import { broadClassicScopes } from "./config/setup.js";
import { resolveGitHubAuth } from "./github/auth.js";
import { verifyGitHubToken } from "./github/verify.js";
import type { Engine } from "./permissions/engine.js";
import { resolveDecision } from "./permissions/engine.js";
import type { PermissionMode } from "./permissions/types.js";
import { isReadOnlyTool } from "./permissions/rules.js";
import { resolveEngine } from "./permissions/index.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  key: string;
  status: CheckStatus;
  message: string;
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

/**
 * How to run the diagnostics without touching the network.
 *
 * The GitHub check has to ask GitHub who the token belongs to — that is the only
 * way to report scopes and the remaining rate limit — and a test that reaches
 * api.github.com is a test that fails on a laptop in a tunnel and a suite that
 * cannot be run offline. `fetchImpl` is therefore injectable, and omitting it
 * means the real `fetch`, which is what the CLI does.
 */
export interface DoctorOptions {
  fetchImpl?: typeof fetch | undefined;
}

const NODE_REQUIRED_MAJOR = 22;

function nodeCheck(): DoctorCheck {
  const raw = process.version.slice(1);
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  const ok = Number.isFinite(major) && major >= NODE_REQUIRED_MAJOR;
  return {
    key: "node-version",
    status: ok ? "ok" : "fail",
    message: `node ${process.version} (>= ${NODE_REQUIRED_MAJOR} required)`,
  };
}

function platformCheck(): DoctorCheck {
  return {
    key: "platform",
    status: "info",
    message: `${process.platform} ${process.arch}`,
  };
}

function dataDirCheck(): DoctorCheck {
  // `jaaHome()`, not `join(homedir(), ".jaa")`: every other module in the
  // codebase resolves the root through it, so hard-coding `homedir()` here made
  // `JAA_HOME` change every other path and not this one — a diagnostic that
  // reported the real `~/.jaa` while every write went to the override.
  const dir = jaaHome();
  const exists = existsSync(dir);
  return {
    key: "data-dir",
    status: "info",
    message: `${dir}${exists ? "" : " (not yet created)"}`,
  };
}

function gitCheck(): DoctorCheck {
  try {
    const out = execFileSync("git", ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return { key: "git", status: "ok", message: out };
  } catch {
    return {
      key: "git",
      status: "warn",
      message: "git not found on PATH",
      detail: "The agent falls back to a built-in file API, but version control features need git.",
    };
  }
}

function tmpCheck(): DoctorCheck {
  const probe = join(tmpdir(), `.jaa-doctor-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(probe, "1");
    rmSync(probe, { force: true });
    return { key: "tmp-writable", status: "ok", message: `temp dir writable: ${tmpdir()}` };
  } catch (err) {
    return {
      key: "tmp-writable",
      status: "fail",
      message: `temp dir not writable: ${tmpdir()}`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function providersCheck(): DoctorCheck {
  const statuses = providerStatuses((def) => hasKey(def));
  const configured = statuses.filter((s) => s.configured);
  const detail =
    configured.length === 0
      ? "none yet — run `jaa setup` to configure a provider"
      : configured.map((s) => `${s.id}${s.localOnly ? " (local)" : s.source ? ` (${s.source})` : ""}`).join(", ");
  return {
    key: "providers",
    status: configured.length > 0 ? "ok" : "info",
    message: `${configured.length} provider(s) configured`,
    detail,
  };
}

/**
 * Report the GitHub credential, and only ever in its masked form.
 *
 * Four things an operator cannot otherwise answer: which source jaa will use
 * (there are seven, and the first three are process environment, so an
 * apparently-missing stored token is usually an exported one), which token it
 * is, what it may do, and how much of the rate limit is left.
 *
 * `anonymous` is a legitimate state, not a failure: public reads work, and a
 * missing token is a normal way to run. It is `info` and says what it costs —
 * a lower rate limit and no private repositories.
 *
 * A rate limit is reported only when one was actually read. With no token
 * nothing is sent, so there is no number to report and the check says so
 * instead of quoting GitHub's documented anonymous ceiling as if it were the
 * remaining count.
 */
async function githubAuthCheck(opts: DoctorOptions): Promise<DoctorCheck> {
  const auth = resolveGitHubAuth();

  if (auth.token === undefined) {
    return {
      key: "github-auth",
      status: "info",
      message: "github: anonymous (no token configured)",
      detail:
        "public access works, so GitHub-backed features run; unauthenticated requests are capped at 60/hour against " +
        "5,000/hour for a token, and private repositories are invisible to jaa. Rate limit remaining was not read: " +
        "nothing was sent, so there was nothing to read it from. `jaa key set github` configures one.",
    };
  }

  const masked = maskToken(auth.token);
  const verified = await verifyGitHubToken(auth.token, {
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });

  if (!verified.ok) {
    return {
      key: "github-auth",
      status: "warn",
      message: `github: token from ${auth.source} (${masked}) was not accepted`,
      // The reason came from GitHub, so it is scrubbed like any other untrusted
      // body. The token itself is replaced by `maskToken` above and never
      // appears below.
      detail: `${redact(verified.error ?? "no reason given")} GitHub-backed features will fail until this is replaced: \`jaa key set github\`.`,
    };
  }

  const scopes = verified.identity?.scopes ?? [];
  const broad = broadClassicScopes(scopes);
  const scopeText =
    scopes.length === 0
      ? "none reported (expected for a fine-grained token, which grants per-repository permissions instead of OAuth scopes)"
      : scopes.join(", ");
  const rateText =
    verified.rateLimitRemaining === undefined
      ? "not reported by GitHub in that response"
      : `${String(verified.rateLimitRemaining)} request(s) left`;

  const detail = [`scopes: ${scopeText}`, `rate limit remaining: ${rateText}`];
  if (broad.length > 0) {
    detail.push(
      `this classic token carries broad scopes (${broad.join(", ")}) — more authority than a coding agent needs; ` +
        "a fine-grained, read-only token scoped to specific repositories is the better credential",
    );
  }

  return {
    key: "github-auth",
    // `warn`, not `ok`, for a working but over-privileged token: the token works,
    // and that is the problem. Same convention as the permissions check, which
    // warns about a reachable bash rather than about a broken one.
    status: broad.length > 0 ? "warn" : "ok",
    message: `github: ${auth.source} (${masked}) verified as ${verified.identity?.login ?? "an unnamed account"}`,
    detail: detail.join("; "),
  };
}

/**
 * Report the effective permission posture: which mode is active, whether a
 * Claude Code policy was imported, and whether bash is reachable at all. The
 * point is that an operator can always answer "what is this session allowed
 * to do" without reading the source.
 */
function permissionsCheck(): DoctorCheck {
  const { mode, rules, engine, projectPolicyFound, projectPolicyApplied } = resolveEngine();
  const denies = rules.filter((r) => r.decision === "deny");
  const allows = rules.filter((r) => r.decision === "allow");

  // Report the decision the gate would ACTUALLY reach, not the presence of an
  // allow rule. A rule can exist and still lose to a more specific one, so
  // "bash IS allowed by an explicit rule" could contradict `jaa perm test bash`.
  const effectiveBash = effectiveDecision(engine, mode, "bash", { command: "ls" });
  const effectiveGitDiff = effectiveDecision(engine, mode, "git_diff", {});

  const parts = [
    `${allows.length} allow / ${denies.length} deny rule(s)`,
    projectPolicyFound
      ? projectPolicyApplied
        ? "project .claude/settings.json APPLIED"
        : "project .claude/settings.json found but NOT applied (untrusted repo)"
      : "no project .claude/settings.json",
    `bash: ${effectiveBash}`,
    `git_diff: ${effectiveGitDiff}${effectiveGitDiff === "ask" ? " (can run a repo-local diff driver)" : ""}`,
  ];
  return {
    key: "permissions",
    status: effectiveBash === "allow" || effectiveGitDiff === "allow" || projectPolicyApplied ? "warn" : "ok",
    message: `permission mode: ${mode}`,
    detail: parts.join("; "),
  };
}

/** The decision the permission gate reaches for one representative call. */
function effectiveDecision(
  engine: Engine,
  mode: PermissionMode,
  tool: string,
  args: Record<string, unknown>,
): "allow" | "deny" | "ask" {
  const outcome = engine.evaluate({
    tool,
    args,
    cwd: process.cwd(),
    root: process.cwd(),
  });
  return resolveDecision(outcome, mode, isReadOnlyTool(tool), tool);
}

/**
 * Report what the host can actually enforce.
 *
 * An unavailable sandbox is shown as `warn`, not hidden: a missing boundary is
 * the single most important thing an operator needs to know before letting an
 * agent run shell commands.
 */
async function sandboxCheck(): Promise<DoctorCheck> {
  const { detectCapability } = await import("./sandbox/detect.js");
  const cap = await detectCapability();
  if (!cap.available) {
    return {
      key: "sandbox",
      status: "warn",
      message: "no OS sandbox available on this host",
      detail:
        `${cap.reason ?? "unknown"} The bash tool will REFUSE to run commands unless you pass ` +
        "--no-sandbox, which runs them without isolation. The git tools run hardened but unisolated. " +
        "For real isolation on this platform use a container or VM.",
    };
  }
  return {
    key: "sandbox",
    status: "ok",
    message: `sandbox: ${cap.mechanism}`,
    detail: `enforces ${cap.enforces.join(", ") || "nothing"}${
      cap.doesNotEnforce.length > 0 ? `; does NOT enforce ${cap.doesNotEnforce.join(", ")}` : ""
    }`,
  };
}

/**
 * Runs environment diagnostics.
 *
 * Everything except the GitHub check is synchronous and offline: the git probe
 * uses `execFileSync` under a try/catch so a missing git never throws, and the
 * temp-dir probe creates and removes its own file. The GitHub check is the one
 * asynchronous, networked check, and it is the one that can inject a `fetchImpl`.
 */
export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  return {
    checks: [
      nodeCheck(),
      platformCheck(),
      dataDirCheck(),
      gitCheck(),
      providersCheck(),
      await githubAuthCheck(opts),
      permissionsCheck(),
      await sandboxCheck(),
      await orchestratorCheck(),
      tmpCheck(),
    ],
  };
}

/**
 * Report what multi-agent orchestration can actually do on this host.
 *
 * Two facts an operator needs before a fan-out: the caps that will be applied to
 * it whether they asked for them or not, and whether worktree isolation is
 * available. The second is the one that changes behaviour — a fan-out without
 * worktrees has concurrent writers on one checkout, which corrupts files
 * silently — so a host that cannot isolate gets a `warn`, not a footnote.
 */
async function orchestratorCheck(): Promise<DoctorCheck> {
  const { DEFAULT_POOL_LIMITS, HARD_CEILING, clampLimits } = await import("./orchestrator/pool.js");
  const { worktreeCapability } = await import("./orchestrator/isolation.js");
  const limits = clampLimits();
  const worktree = await worktreeCapability();

  const detail =
    `limits: maxThreads ${limits.maxThreads}, maxDepth ${limits.maxDepth}, ` +
    `maxTasks ${limits.maxTasks} (defaults ${DEFAULT_POOL_LIMITS.maxThreads}/${DEFAULT_POOL_LIMITS.maxDepth}/${DEFAULT_POOL_LIMITS.maxTasks}, ` +
    `hard ceiling ${HARD_CEILING.maxThreads}/${HARD_CEILING.maxDepth}/${HARD_CEILING.maxTasks}). ` +
    (worktree.available
      ? "Worktree isolation is available: `jaa agent run --isolation worktree` gives each parallel worker its own checkout."
      : `Worktree isolation is NOT available (${worktree.reason ?? "unknown"}). ` +
        "Parallel workers will share one checkout, so `jaa agent run --alongside` on overlapping files can lose writes silently. " +
        "Use --isolation worktree in a git repository to avoid it.");

  return {
    key: "orchestrator",
    status: worktree.available ? "ok" : "warn",
    message: worktree.available ? "multi-agent orchestration ready" : "multi-agent ready, but without worktree isolation",
    detail,
  };
}

/** Renders a report as aligned terminal lines. */
export function formatReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const marker = `[${c.status}]`;
    return `${marker.padEnd(7)} ${c.key.padEnd(12)} ${c.message}${c.detail ? `\n${" ".repeat(21)}↳ ${c.detail}` : ""}`;
  });
  return lines.join("\n");
}