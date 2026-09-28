import { execFileSync } from "node:child_process";
import { EnvLayers, findSecret } from "../config/env.js";
import { readKeyring } from "../config/keyring.js";

/**
 * Where a GitHub token came from. Always present, including for
 * `"anonymous"` — a caller that has to distinguish "no token" from "the token
 * lookup failed" cannot do it from an `undefined` alone, because an
 * unauthenticated run is a normal outcome, not a failure.
 */
export type GitHubTokenSource =
  | "env:JAA_GITHUB_TOKEN"
  | "env:GITHUB_TOKEN"
  | "env:GH_TOKEN"
  | "project-env"
  | "keyring"
  | "gh-cli"
  | "anonymous";

export interface GitHubAuth {
  /** Undefined exactly when `source` is `"anonymous"`. */
  token: string | undefined;
  source: GitHubTokenSource;
}

/**
 * Candidate names, in precedence order. The jaa-specific name comes first so a
 * token set for this project wins over one the shell happens to export.
 */
const ENV_CANDIDATES = ["JAA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;

const ENV_SOURCE: Record<(typeof ENV_CANDIDATES)[number], GitHubTokenSource> = {
  JAA_GITHUB_TOKEN: "env:JAA_GITHUB_TOKEN",
  GITHUB_TOKEN: "env:GITHUB_TOKEN",
  GH_TOKEN: "env:GH_TOKEN",
};

/** `gh` is only ever asked for a token, so it is not worth waiting long for. */
const GH_TIMEOUT_MS = 2_000;

/** A value is usable only if it has something in it. */
function usable(raw: string): string | undefined {
  const value = raw.trim();
  return value === "" ? undefined : value;
}

/**
 * `gh auth token`, or undefined. Synchronous because the resolver is
 * synchronous — a token is needed to build a request, and there is nothing to
 * await in between.
 *
 * Every failure is the same answer: `gh` not on PATH, not logged in, timed out,
 * non-zero exit, or nothing on stdout. `gh` also writes diagnostics to stderr
 * ("not logged into any GitHub hosts"), so stderr is discarded rather than
 * propagated — a token lookup must not be able to fail loudly.
 */
function ghCliToken(): string | undefined {
  try {
    const stdout = execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return usable(stdout);
  } catch {
    return undefined;
  }
}

/**
 * Finds a GitHub token, first hit wins:
 *
 *   1. `JAA_GITHUB_TOKEN`  2. `GITHUB_TOKEN`  3. `GH_TOKEN`   (process env)
 *   4. the project `.env`  5. `~/.jaa/.env` (keyring)  6. `gh auth token`
 *   7. nothing — anonymous
 *
 * ## Why the process-env ladder is walked name by name
 *
 * `findSecret` scans its candidates in order, and each candidate is resolved
 * through the layers *underneath* it. So `findSecret([a, b, c])` returns `a` from
 * the project `.env` before `b` from `process.env` — a project file would
 * outrank the shell. That is the wrong answer for a credential: the shell is
 * where an operator exports the token they mean for this run, and it is the
 * layer a wrapper script just set. So each candidate is asked for separately and
 * kept only if it came from `"process"`, which restores name-major order within
 * the layer that outranks everything else.
 *
 * The project layer is then read from an `EnvLayers` built for `projectDir`
 * rather than through `findSecret`, because `findSecret` is bound to the
 * module-level singleton that was built for `process.cwd()`. A caller that
 * passes a `projectDir` would otherwise silently be answered about a different
 * directory's `.env`. No caching, either: a user who just edited `.env` must not
 * be told about the previous contents.
 */
export function resolveGitHubAuth(opts?: { projectDir?: string }): GitHubAuth {
  const projectDir = opts?.projectDir ?? process.cwd();

  for (const name of ENV_CANDIDATES) {
    const ref = findSecret([name]);
    if (ref?.source !== "process") continue;
    const token = usable(ref.value);
    if (token !== undefined) return { token, source: ENV_SOURCE[name] };
  }

  const project = new EnvLayers(projectDir, undefined);
  for (const name of ENV_CANDIDATES) {
    const ref = project.get(name);
    if (ref?.source !== "project") continue;
    const token = usable(ref.value);
    if (token !== undefined) return { token, source: "project-env" };
  }

  // The keyring only exposes `JAA_`-prefixed keys, which is why the stored name
  // is `JAA_GITHUB_TOKEN` and not `GITHUB_TOKEN`.
  const stored = usable(readKeyring().get("JAA_GITHUB_TOKEN") ?? "");
  if (stored !== undefined) return { token: stored, source: "keyring" };

  const cli = ghCliToken();
  if (cli !== undefined) return { token: cli, source: "gh-cli" };

  return { token: undefined, source: "anonymous" };
}

/**
 * The only GitHub hosts a token is ever sent to.
 *
 * Exact-match, not suffix-match. `github.com.evil.com` ends with a GitHub name
 * and is not GitHub, and every allowlist written as a suffix test eventually
 * grows one of those.
 */
export const GITHUB_HOSTS: readonly string[] = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
];

/**
 * Whether `url` is an https URL on a GitHub host.
 *
 * Parsed, not pattern-matched, because the interesting attacks are all about
 * what the string *looks* like versus where it *points*: `https://github.com@evil.com`
 * reads as GitHub to any `includes("github.com")` check and its real host is
 * `evil.com`. `new URL()` answers the question that matters. Scheme is required
 * because a token sent over http is a token sent in the clear, and the scheme is
 * the only part of the URL that decides that. Unparseable input is false.
 */
export function isGitHubHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return GITHUB_HOSTS.some((allowed) => allowed === host);
}

/**
 * The auth header for a request, or `{}` when there is no token to send.
 *
 * The single place in the codebase where a token becomes part of a header. One
 * call site is the point: a second one is a second thing to audit, and a token
 * that leaks to a non-GitHub host is exactly what {@link isGitHubHost} exists to
 * stop.
 */
export function githubAuthHeader(auth: GitHubAuth): Record<string, string> {
  const token = usable(auth.token ?? "");
  if (token === undefined) return {};
  return { authorization: `Bearer ${token}` };
}
