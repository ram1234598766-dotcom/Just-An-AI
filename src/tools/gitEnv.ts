/**
 * The one place git's hardening and git's authentication are decided.
 *
 * Two things used to live as copies, and a copy of a security list is a list that
 * will drift: `GIT_CONFIG` sat in both `src/tools/git.ts` (for the read-only
 * tools) and `src/skills/install.ts` (for a clone) until the two began to differ
 * in the comments explaining them, and the day they differ in the *values* is
 * the day one caller silently loses `credential.helper=`. The env allowlist had
 * the same problem in a milder form, split across the `envPassthrough` lists in
 * `git.ts` and `bash.ts`. So: one definition, imported by both callers, and one
 * function that decides whether a given remote gets a token.
 */

import { githubAuthHeader, isGitHubHost, resolveGitHubAuth } from "../github/auth.js";

/**
 * Top-level git hardening: `-c` config overrides, which must appear BEFORE the
 * subcommand. This is the canonical list; there is no second one.
 *
 * `core.fsmonitor` matters as much as the rest: a repository-local
 * `[core] fsmonitor = /path/to/program` is executed by `git status` and
 * `git diff`, so without `-c core.fsmonitor=false` a `write_file` into
 * `.git/config` is code execution even with `--no-ext-diff` in place. Verified
 * on Linux with the exact argv below.
 *
 * Two entries are load-bearing for a *clone* specifically, which is why the same
 * list serves both callers rather than each keeping its own:
 *
 *  - `credential.helper=` — otherwise git may consult a helper from
 *    `~/.gitconfig` and supply or persist a credential of its own choosing.
 *  - `protocol.ext.allow=never` — closes the `ext::` transport that executes a
 *    helper program.
 *
 * `core.hooksPath=` and `core.fsmonitor=false` are here for the same reason they
 * always were: a repository-local config value that git executes, and which a
 * freshly cloned repo now contains.
 *
 * These are command-scoped and are never written to any repository's
 * `.git/config`. The environment form in {@link gitAuthEnv} has exactly that
 * same scope, which is why a token can ride along without being persisted.
 */
export const GIT_CONFIG: readonly string[] = [
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
 * Refuse to ask for a credential interactively.
 *
 * Set unconditionally wherever a git invocation might reach a remote. With no
 * terminal to answer it, a missing credential is otherwise a hang until the
 * timeout, which is the worst way to learn that a private repo needs auth — and
 * a child process with no controlling terminal is the case that matters, since
 * that is how `runProcess` spawns git.
 *
 * Typed as the literal `"0"` so a caller cannot spread a `boolean` here by
 * accident: the value is an argv-free environment string, and `false` there
 * would be the string `"false"`, which git does not read as "off".
 */
export const GIT_TERMINAL_PROMPT: "0" = "0";

/**
 * The variables a git child is given, by name.
 *
 * An allowlist, never `scrubEnv`'s denylist. A denylist has to be right about
 * every variable that does not exist *yet*: the day a user exports
 * `GITLAB_TOKEN` or `AWS_SESSION_TOKEN` a denylist must be edited, and a
 * name-not-credential-shaped variable like `CAAS_ARTIFACTORY_READER_PASSWORD`
 * sails straight through it. An allowlist's failure mode is the safe direction —
 * an unlisted variable is dropped, and a new credential is therefore dropped with
 * it until somebody decides to add it on purpose.
 *
 * The union of the two `envPassthrough` lists the sandbox wrappers in
 * `git.ts` and `bash.ts` already agreed on (PATH/HOME/USERPROFILE/SystemRoot/
 * COMSPEC plus LANG and the temp trio), and nothing else from the parent.
 *
 * The proxy variables are the one addition, and they are here because dropping
 * them breaks every clone behind a corporate proxy — a failure that would look
 * like a network outage rather than a hardening change. They carry no credential
 * by convention; a proxy URL *can* embed one, and that is the operator's own
 * proxy configuration being handed to `git`, which is what running `git clone`
 * yourself would do too. Both cases are listed because `process.env` is
 * case-insensitive on Windows and case-sensitive on POSIX, so `http_proxy` and
 * `HTTP_PROXY` are genuinely two different lookups.
 */
export const GIT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "LANG",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

/**
 * The allowlisted, non-secret baseline, read from the current process.
 *
 * This is what a git invocation that contacts **no remote** gets. It matters
 * because `runProcess` treats an omitted `env` as "inherit everything", and on a
 * host with no sandbox — which is every Windows host, and Windows has no
 * sandbox mechanism to install — that inheritance is the real boundary: a
 * `GITHUB_TOKEN` in the operator's shell reaches the child with no code having
 * asked for it. Naming the variables is the only way to take that back.
 *
 * Deliberately excludes anything that could carry a credential, which is why the
 * auth variables in {@link gitAuthEnv} are *not* merged in by default. A local
 * `git status` has no remote to authenticate to, so a token on it would be
 * exposure with no possible use.
 */
export function baseGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GIT_ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface GitAuthEnvOptions {
  /** The remote URL or repo argument this git invocation will contact, if any. */
  remoteUrl?: string;
  /** Skip the token entirely even when one is configured. */
  anonymous?: boolean;
}

/**
 * The authentication environment for one git invocation, or `{}`.
 *
 * ## The three refusals, and why each is a refusal
 *
 *  - **No `remoteUrl`.** There is nothing to authorise, so there is nothing to
 *    send. Asking first is also what keeps a local `git status` from paying for
 *    a token lookup: {@link resolveGitHubAuth} falls through to `gh auth token`,
 *    a subprocess, and there is no reason to spawn one for a command that will
 *    never open a socket.
 *  - **`anonymous`.** The caller said no. An explicit opt-out is honoured even
 *    when a token is sitting right there, because "unauthenticated" is a
 *    legitimate thing to want (a public clone behind a rate limit, a provenance
 *    check).
 *  - **Not an https GitHub URL.** Everything else. `isGitHubHost` parses rather
 *    than pattern-matches, requires the scheme, and exact-matches the host, so
 *    the shapes that get nothing are: a cleartext `http://github.com/...` (a
 *    bearer token over http is a token in the clear), `git://github.com/...`
 *    (the unauthenticated git protocol, which has no header mechanism at all),
 *    any other host including a lookalike like `github.com.evil.test`, and the
 *    scp-style `git@github.com:owner/repo.git`.
 *
 * That last one is worth stating plainly: **an SSH remote gets nothing, and that
 * is correct rather than a gap.** SSH authenticates with a key through the SSH
 * agent, not with an HTTP header, so `http.extraHeader` would be silently ignored
 * by `git clone ssh://…` — a token in the environment, read by nothing. Handing
 * SSH its credentials is a different mechanism (an `SSH_ASKPASS` helper or a
 * deploy key) and out of scope here; what matters is that this one does not
 * pretend to cover it.
 *
 * ## Why the environment and never the argv
 *
 * `-c http.extraHeader=Authorization: Bearer …` on the command line is simpler
 * and is **forbidden**. On POSIX any process can read another process's command
 * line through the process list, so argv publishes the token to every user on
 * the host. `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` is the
 * environment form of the same `-c` override: git reads it for this invocation
 * and never persists it, so it appears in neither the process list nor the
 * repository's `.git/config`.
 *
 * The header value comes from {@link githubAuthHeader}, the single function that
 * turns a token into a header, so the bytes are identical to the ones
 * `fetch_url` sends. It is built that way deliberately: `GIT_CONFIG_VALUE_0`
 * contains none of TOKEN/SECRET/PASSWORD/PASSWD/KEY/CREDENTIAL/AUTH, so it
 * survives any name-based scrubber a caller runs on the way to the child, which
 * the credential-shaped alternatives (`GIT_ASKPASS` with the token as an
 * argument, an `http.extraHeader` under a name like `GITHUB_TOKEN`) would not.
 */
export function gitAuthEnv(opts: GitAuthEnvOptions = {}): Record<string, string> {
  const remoteUrl = opts.remoteUrl;
  if (remoteUrl === undefined) return {};
  if (opts.anonymous === true) return {};
  if (!isGitHubHost(remoteUrl)) return {};

  const authorization = githubAuthHeader(resolveGitHubAuth())["authorization"];
  if (authorization === undefined) return {};

  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
    GIT_TERMINAL_PROMPT,
  };
}

/**
 * The complete environment for a git invocation that contacts `remoteUrl`.
 *
 * {@link baseGitEnv} plus {@link gitAuthEnv}, plus `GIT_TERMINAL_PROMPT`
 * unconditionally — including when the host is not GitHub, because a
 * non-GitHub remote that cannot authenticate should *fail*, not sit on a
 * credential prompt until the timeout.
 *
 * ## Who calls this
 *
 * `src/skills/install.ts`, for the clone. Not any of the tools in `git.ts`:
 * `git_status`, `git_log`, `git_diff` and `git_show` run against the local
 * repository and have no remote, so they get {@link baseGitEnv} and nothing
 * else. No new subcommand was added to reach a remote through a tool — see the
 * report for why the read-only set genuinely cannot get there, and this stays
 * exported so the next caller that does need it has one decision to make rather
 * than three.
 */
export function gitRemoteEnv(remoteUrl: string): Record<string, string> {
  return { ...baseGitEnv(), ...gitAuthEnv({ remoteUrl }), GIT_TERMINAL_PROMPT };
}
