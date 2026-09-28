import { createInterface } from "node:readline/promises";
import { stdout } from "node:process";
import { providerById, PROVIDERS } from "./providers.js";
import type { ProviderDef } from "./providers.js";
import { setKey } from "./keyring.js";
import { loadSettings, saveSettings } from "./settings.js";
import { jaaHome } from "./paths.js";
import { readStdinIfPiped } from "../utils/cli.js";
import { promptHidden } from "../utils/prompt-hidden.js";
import { maskToken, redact } from "./redact.js";
import { classifyToken, verifyGitHubToken } from "../github/verify.js";
import type { TokenShape } from "../github/verify.js";

export interface SetupOptions {
  provider?: string | undefined;
  key?: string | undefined;
  nonInteractive?: boolean | undefined;
  /**
   * `true` runs the GitHub token step without asking, `false` skips it,
   * omitted offers it once on an interactive terminal.
   */
  github?: boolean | undefined;
  acceptUnrecognisedShape?: boolean | undefined;
  /** Injected so a test can verify a token without touching the network. */
  fetchImpl?: typeof fetch | undefined;
}

export interface SetupResult {
  provider: string;
  keyStored: boolean;
  defaultProviderSet: boolean;
  /** Present only when the GitHub step actually stored a token. */
  github?: GitHubTokenOutcome | undefined;
}

/**
 * A GitHub credential, described as a `ProviderDef` so the existing keyring
 * (`setKey`/`hasKey`, which only need `keyringEnv`) can store it.
 *
 * Deliberately NOT a member of `PROVIDERS`: that registry drives the model
 * picker, `providerStatuses` and the router, and a GitHub token is not a model.
 * Adding it there would make `jaa setup` offer GitHub as a language model and
 * make `jaa key list` imply a provider that jaa cannot route to. `jaa key list`
 * therefore prints this entry explicitly.
 */
export const GITHUB_CREDENTIAL: ProviderDef = {
  id: "github",
  label: "GitHub",
  envKeys: ["JAA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"],
  keyringEnv: "JAA_GITHUB_TOKEN",
  note: "A GitHub credential, not a model provider: used by `jaa skill install` and other GitHub-backed features.",
};

/** The flag that overrides the local shape check, named for what it does. */
export const GITHUB_SHAPE_OVERRIDE_FLAG = "--accept-unrecognised-shape";

/**
 * Scopes a coding agent has no business holding.
 *
 * Matched by exact name, plus every `admin:*`, because GitHub's admin family is
 * a set of scopes that grows over time and an allowlist of the ones remembered
 * today is exactly how one is missed. A substring test is the other trap:
 * `public_repo` contains `repo`, so `scopes.includes("repo")` on a *joined*
 * string would fire on a far weaker token.
 */
const BROAD_SCOPES: readonly string[] = ["repo", "workflow", "write:public_key", "delete_repo"];

export function broadClassicScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => BROAD_SCOPES.includes(scope) || scope.startsWith("admin:"));
}

/**
 * Why a broad classic token is a bad default, in one paragraph. Not a block:
 * the operator may have a reason, and the job is to make the risk legible, not
 * to take the decision away.
 */
export function broadScopeWarning(found: readonly string[]): string | undefined {
  if (found.length === 0) return undefined;
  return (
    `warning: this classic token carries broad scopes (${found.join(", ")}). That is far more authority than a ` +
    "coding agent needs, and a leak of it is a repository-wide or organization-wide problem rather than a local one. " +
    "Prefer a fine-grained, read-only token scoped to the specific repositories you want: " +
    "Settings -> Developer settings -> Personal access tokens -> Fine-grained tokens."
  );
}

/** The warning that must accompany the shape-check override, every time. */
export function shapeOverrideWarning(): string {
  return (
    `warning: ${GITHUB_SHAPE_OVERRIDE_FLAG} skipped the local format check, so jaa cannot tell a token from a ` +
    "mistyped paste. GitHub still has to accept it; if it does not, the failure will surface at the next request " +
    "rather than here."
  );
}

export interface GitHubTokenOptions {
  acceptUnrecognisedShape?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface GitHubTokenOutcome {
  login: string;
  scopes: string[];
  /** Last four characters only, for showing the operator their own value. */
  masked: string;
  shape: TokenShape;
  broadScopes: string[];
  rateLimitRemaining?: number | undefined;
}

/**
 * Where the value of a GitHub token may come from — a pipe, or a terminal.
 *
 * Both halves are overridable so a test can exercise the choice between them
 * without a TTY and without a pipe, which is the same seam `fetchImpl` is on
 * `verifyGitHubToken`.
 */
export interface GitHubTokenInput {
  /** A value already read from piped stdin, if there was one. */
  piped?: string | undefined;
  prompt?: ((question: string) => Promise<string>) | undefined;
}

const GITHUB_PROMPT = "Paste your GitHub token (input is hidden): ";

/**
 * Reads a GitHub token, preferring a pipe and otherwise using the no-echo prompt.
 *
 * A pipe is checked first and is the better route when there is one: it never
 * reaches the screen at all, so there is no echo to suppress. `promptHidden`
 * refuses on a non-TTY rather than degrading, so a session with neither ends
 * here with an error instead of printing the secret.
 */
export async function readGitHubTokenInput(input: GitHubTokenInput = {}): Promise<string> {
  if (input.piped !== undefined) return input.piped;
  if (typeof input.prompt === "function") return input.prompt(GITHUB_PROMPT);
  const piped = await readStdinIfPiped();
  if (piped !== undefined && piped.trim() !== "") return piped;
  return promptHidden(GITHUB_PROMPT);
}

/**
 * What `jaa key set github` prints once a token is verified and stored.
 *
 * Lives next to the outcome it renders rather than in the command file so that
 * the two cannot drift, and so the "what is actually stored" line is testable
 * without running the CLI. The store line names the file rather than calling it
 * a "keyring": there is no OS keyring backend in this build, so `~/.jaa/.env` at
 * mode 0600 on POSIX is the whole of the protection, and naming it "keyring"
 * would imply a guarantee that does not exist.
 */
export function reportGitHubToken(outcome: GitHubTokenOutcome): void {
  const lines = [
    `github token verified and stored as ${outcome.masked} in ${jaaHome()}/.env ` +
      "(mode 0600 on POSIX; there is no OS keyring backend, so this file is the store)",
    `  login:  ${outcome.login}`,
    `  scopes: ${
      outcome.scopes.length === 0
        ? "none reported — a fine-grained token grants per-repository permissions instead of OAuth scopes"
        : outcome.scopes.join(", ")
    }`,
  ];
  if (outcome.rateLimitRemaining !== undefined) {
    lines.push(`  rate limit: ${String(outcome.rateLimitRemaining)} request(s) left`);
  }
  // A token widens no permission mode, so say it before somebody assumes that
  // configuring one is what unlocks GitHub writes.
  lines.push("  a token never widens a permission mode; jaa's rules decide every write on their own");
  console.log(lines.join("\n"));
  const warning = broadScopeWarning(outcome.broadScopes);
  if (warning !== undefined) process.stderr.write(`${warning}\n`);
}

/**
 * Validates, verifies and only then stores a GitHub token.
 *
 * The order is the whole point. Nothing is written until GitHub has confirmed
 * the token names a real account, so a failure leaves the keyring byte for byte
 * as it was: a stored token that 401s on every subsequent call is worse than no
 * token, because it fails with a confusing reason instead of an absent one.
 *
 * Every throw means "nothing was stored". The token never appears in a thrown
 * message, and the reason from GitHub goes through `redact` on the way out
 * because it is a body jaa did not write.
 */
export async function setGitHubToken(value: string, opts: GitHubTokenOptions = {}): Promise<GitHubTokenOutcome> {
  const token = value.trim();
  if (token === "") throw new Error("no token given — nothing to verify and nothing stored");

  const shape = classifyToken(token);
  if (shape === "unknown") {
    if (opts.acceptUnrecognisedShape !== true) {
      throw new Error(
        "that value does not look like a GitHub token, so it was rejected without contacting GitHub. " +
          "A classic PAT is 40 hex characters, an OAuth-family token starts with ghp_/gho_/ghu_/ghs_/ghr_, and a " +
          `fine-grained token starts with github_pat_. If it really is a token in a shape this build does not know, ` +
          `re-run with ${GITHUB_SHAPE_OVERRIDE_FLAG}.`,
      );
    }
    // Emitted here rather than at each call site, so there is no path that takes
    // the override without saying what was given up.
    process.stderr.write(`${shapeOverrideWarning()}\n`);
  }

  const verified = await verifyGitHubToken(token, {
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });
  if (!verified.ok) {
    throw new Error(
      `GitHub rejected the token — nothing was stored. ${redact(verified.error ?? "no reason given")}`,
    );
  }

  const identity = verified.identity;
  if (identity === undefined) {
    // Unreachable while `ok` implies an identity, but the type says `identity?`
    // and a store that ran on a value the verifier never identified would be a
    // far worse bug than a redundant branch.
    throw new Error("GitHub accepted the request but named no account — nothing was stored");
  }

  setKey(GITHUB_CREDENTIAL, token);

  const masked = maskToken(token);
  return {
    login: identity.login,
    scopes: identity.scopes,
    masked,
    shape,
    broadScopes: broadClassicScopes(identity.scopes),
    ...(verified.rateLimitRemaining === undefined
      ? {}
      : { rateLimitRemaining: verified.rateLimitRemaining }),
  };
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: stdout });
  return rl.question(question).finally(() => rl.close());
}

/** Yes/no on stderr, matching `askOnTty`. A non-TTY, a closed stdin and "no" are all "no". */
async function askYesNo(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    answer = await rl.question(`${question} [y/N]: `);
  } catch {
    return false;
  } finally {
    rl.close();
  }
  const normalized = answer.trim().toLowerCase();
  return normalized === "y" || normalized === "yes";
}

function pickProvider(provider?: string): Promise<string> {
  if (provider) {
    if (!providerById(provider)) throw new Error(`unknown provider "${provider}"`);
    return Promise.resolve(provider);
  }
  const lines = PROVIDERS.map((p, i) => `  ${i + 1}. ${p.label} (${p.id})`).join("\n");
  return (async () => {
    const answer = await prompt(`Select a provider:\n${lines}\nprovider> `);
    const idx = Number.parseInt(answer.trim(), 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= PROVIDERS.length) {
      return PROVIDERS[idx - 1]!.id;
    }
    if (providerById(answer.trim())) return answer.trim();
    throw new Error(`unknown provider "${answer.trim()}"`);
  })();
}

/** What the GitHub step should do, and why. */
type GitHubStep =
  | { kind: "skip" }
  | { kind: "offer" }
  | { kind: "run"; stdinAvailable: boolean };

function githubStep(opts: SetupOptions, stdinConsumed: boolean): GitHubStep {
  if (opts.github === false) return { kind: "skip" };
  const interactive = process.stdin.isTTY === true;
  if (opts.github === true) return { kind: "run", stdinAvailable: !stdinConsumed };
  // Opted out by `--yes`, and there is no terminal to ask on.
  if (opts.nonInteractive === true || !interactive) return { kind: "skip" };
  return { kind: "offer" };
}

/**
 * The GitHub step, shared by `jaa setup` and `jaa key set github`.
 *
 * Returns the outcome to report, or undefined when the step did not run. All
 * the rules live in `setGitHubToken`; this only decides whether to ask and where
 * the value comes from.
 */
async function runGitHubStep(opts: SetupOptions, stdinConsumed: boolean): Promise<GitHubTokenOutcome | undefined> {
  const step = githubStep(opts, stdinConsumed);

  if (step.kind === "skip") return undefined;
  if (step.kind === "offer") {
    const wants = await askYesNo("Configure a GitHub token now? (needed for private repos and `skill install`)");
    if (!wants) return undefined;
  }

  const value = await readGitHubTokenInput({
    // A pipe the provider key already drained has nothing left in it, so the
    // prompt is the only route — which on a drained non-TTY is a refusal, and a
    // correct one.
    ...(step.kind === "run" && !step.stdinAvailable ? { piped: undefined, prompt: promptHidden } : {}),
  });
  return setGitHubToken(value, {
    ...(opts.acceptUnrecognisedShape === undefined
      ? {}
      : { acceptUnrecognisedShape: opts.acceptUnrecognisedShape }),
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
  });
}

/**
 * One-command setup. Interactive when run on a TTY; pass `--provider --key`
 * (or pipe the key on stdin) for scripted/silent use.
 *
 * `--key` is kept because removing it breaks every existing script, but it is
 * the worst of the three ways to hand a secret to a process, so it now says so.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  if (opts.key !== undefined && opts.key !== "") {
    process.stderr.write(
      "jaa: warning: --key puts the secret in the process list, where any other process on this machine can read " +
        "it, and in your shell history, where a later `history` replays it. Pipe the key on stdin " +
        '(`printf %s "$KEY" | jaa setup --provider openai`), or omit --key to be prompted with the input hidden.\n',
    );
  }

  const id = await pickProvider(opts.provider);
  const def = providerById(id);
  if (!def) throw new Error(`unknown provider "${id}"`);

  let key: string | undefined = opts.key;
  // Tracked so the GitHub step does not try to read a pipe the provider key has
  // already drained — and so a run that piped one key is not silently asked for
  // a second one on a terminal that has nothing left to give.
  let stdinConsumed = false;
  if (!key) {
    const piped = await readStdinIfPiped();
    if (piped !== undefined) {
      key = piped;
      stdinConsumed = true;
    } else if (process.stdin.isTTY !== true) {
      stdinConsumed = true;
    }
  }

  if (!key && !def.localOnly) {
    if (opts.nonInteractive) throw new Error("missing --key for non-interactive setup");
    // Hidden from here on: this is a provider API key, so the readline prompt
    // that used to sit here printed the whole credential to the screen.
    key = (await promptHidden(`Paste your ${def.label} API key (input is hidden): `)).trim();
  }

  let keyStored = false;
  if (key && !def.localOnly) {
    setKey(def, key);
    keyStored = true;
  }

  const settings = loadSettings();
  settings.defaultProvider = id;
  saveSettings(settings);

  const github = await runGitHubStep(opts, stdinConsumed);

  return {
    provider: id,
    keyStored,
    defaultProviderSet: true,
    ...(github === undefined ? {} : { github }),
  };
}
