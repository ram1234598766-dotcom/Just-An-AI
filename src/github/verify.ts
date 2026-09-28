import { REDACTED, redact } from "../config/redact.js";
import { githubAuthHeader } from "./auth.js";
import type { GitHubAuth } from "./auth.js";

/**
 * Token shape from the string alone. No network: this is a guess about a
 * credential's format, used to label what a token *is* (and to notice that a
 * token is not a token), never to decide whether it works.
 */
export type TokenShape = "classic" | "fine-grained" | "oauth" | "unknown";

const USER_ENDPOINT = "https://api.github.com/user";
const VERIFY_TIMEOUT_MS = 10_000;
/** Enough of an error body to be useful, short enough not to become the log. */
const MAX_DETAIL = 300;

/**
 * The shape of a token, from its prefix.
 *
 * `ghp_ gho_ ghu_ ghs_ ghr_` are all the OAuth family — GitHub mints them for
 * different flows but they are the same kind of credential, and calling a
 * `ghs_` a "classic PAT" would send whoever reads the report looking in the
 * wrong place. A bare 40-hex string is the pre-2021 classic PAT, which has no
 * prefix at all. Anything else is `unknown` without a length requirement: the
 * job is to say what is recognisable, and a token shape nobody recognises today
 * should not be reported as invalid today.
 */
export function classifyToken(token: string): TokenShape {
  const value = token.trim();
  if (/^gh[pousr]_/.test(value)) return "oauth";
  if (value.startsWith("github_pat_")) return "fine-grained";
  if (/^[0-9a-f]{40}$/i.test(value)) return "classic";
  return "unknown";
}

export interface VerifiedIdentity {
  login: string;
  scopes: string[];
  tokenKind: TokenShape;
}

export interface VerifyResult {
  ok: boolean;
  identity?: VerifiedIdentity;
  rateLimitRemaining?: number;
  error?: string;
}

/**
 * One line naming the anonymous rate limit, for the two statuses that mean it.
 * Any other status is not a rate limit and saying so would send the reader
 * chasing the wrong problem.
 */
export function rateLimitHint(status: number): string | undefined {
  if (status === 403) {
    return "403 = rate limited or forbidden: unauthenticated callers get 60 requests/hour, an authenticated token gets 5,000.";
  }
  if (status === 429) {
    return "429 = secondary rate limit: back off before retrying; authenticating raises the ceiling from 60 anonymous requests/hour.";
  }
  return undefined;
}

/**
 * Removes the token from a string, by value and then by shape.
 *
 * `redact` alone is not enough here. It matches shapes it has been taught, and
 * the one string that must never survive into an error is *this* token, whatever
 * shape it turns out to be — including one `redact` has never seen. So the
 * literal is removed first, and the shape rules catch everything else that came
 * back in the body.
 */
function scrub(value: string, token: string): string {
  const trimmed = token.trim();
  const withoutToken = trimmed === "" ? value : value.split(trimmed).join(REDACTED);
  return redact(withoutToken);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readRateLimitRemaining(response: Response): number | undefined {
  const raw = response.headers.get("x-ratelimit-remaining");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readScopes(response: Response): string[] {
  const header = response.headers.get("x-oauth-scopes");
  if (header === null) return [];
  return header
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readIdentity(response: Response, token: string): Promise<VerifiedIdentity | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  if (!isRecord(body)) return undefined;
  // A response body is untrusted input: `login` is whatever GitHub sent, and a
  // report that quotes it should not be quoting a number or an object.
  const login = body["login"];
  if (typeof login !== "string" || login.trim() === "") return undefined;
  return { login, scopes: readScopes(response), tokenKind: classifyToken(token) };
}

async function readDetail(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_DETAIL);
  } catch {
    return response.statusText;
  }
}

/** Attaches the rate limit only when the header was there. */
function finish(init: VerifyResult, rateLimitRemaining: number | undefined): VerifyResult {
  return rateLimitRemaining === undefined ? { ...init } : { ...init, rateLimitRemaining };
}

/**
 * Asks GitHub who a token belongs to.
 *
 * `GET /user` is the only endpoint that answers for an arbitrary token, and it
 * is also the cheapest one. `fetchImpl` is injectable so a test never touches
 * the network, and the result is a value rather than a throw: verification runs
 * at startup, where a dead network should produce a clear message and not an
 * unhandled rejection.
 *
 * Nothing in here may put the token in an error, a message or a returned string.
 */
export async function verifyGitHubToken(
  token: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<VerifyResult> {
  const trimmed = token.trim();
  if (trimmed === "") return { ok: false, error: "no token to verify" };

  // The single sanctioned route from a token to a header. `githubAuthHeader`
  // reads `token` and nothing else; the `anonymous` source is a placeholder
  // because a token passed straight to this function did not come through the
  // resolver, and no branch here looks at it.
  const auth: GitHubAuth = { token: trimmed, source: "anonymous" };

  const send = opts?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(USER_ENDPOINT, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "jaa-agent/0.1",
        ...githubAuthHeader(auth),
      },
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, error: `could not reach GitHub: ${scrub(message(err), trimmed)}` };
  }

  const rateLimitRemaining = readRateLimitRemaining(response);

  if (!response.ok) {
    const detail = await readDetail(response);
    const hint = rateLimitHint(response.status);
    const suffix = hint === undefined ? "" : ` (${hint})`;
    return finish({ ok: false, error: `GitHub returned ${String(response.status)}${suffix}: ${scrub(detail, trimmed)}` }, rateLimitRemaining);
  }

  const identity = await readIdentity(response, trimmed);
  if (identity === undefined) {
    return finish({ ok: false, error: "GitHub returned 200 with no usable login in the body" }, rateLimitRemaining);
  }
  return finish({ ok: true, identity }, rateLimitRemaining);
}
