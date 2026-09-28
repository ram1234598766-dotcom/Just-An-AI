import { z } from "zod";
import { githubAuthHeader, isGitHubHost, resolveGitHubAuth } from "../github/auth.js";
import { rateLimitHint } from "../github/verify.js";
import { MAX_TOOL_OUTPUT } from "./registry.js";
import type { GitHubAuth } from "../github/auth.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const fetchSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().min(500).max(60_000).default(15_000),
});

const USER_AGENT = "jaa-agent/0.1";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Redirect statuses that carry a `Location`. 300 and 304 are not redirections. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * How many redirects are followed before the walk gives up.
 *
 * The bound is on *hops*, not on the whole run, so it is the only thing standing
 * between a model-supplied URL and a redirect carousel that never settles. Five is
 * generous for real content (a `github.com/…/blob/…` link is two) and small
 * enough that a loop is reported rather than waited out.
 */
export const MAX_REDIRECT_HOPS = 5;

/**
 * Whether this request may carry the GitHub token, as a header map.
 *
 * The check is against the URL of the request *being made*, never against the URL
 * the walk started from, and never against the previous hop. That is the whole
 * point: `https://github.com/o/r` answering `302 Location: https://evil.test/`
 * must produce a header map with no `authorization` key at all. Carrying the
 * header forward "because we were on GitHub a second ago" is the bug.
 *
 * `githubAuthHeader` is still the only thing that turns a token into a header, and
 * it returns `{}` for a blank or absent token — so the anonymous case needs no
 * branch here.
 */
function authHeadersFor(target: string, auth: GitHubAuth): Record<string, string> {
  return isGitHubHost(target) ? githubAuthHeader(auth) : {};
}

export interface FetchUrlOptions {
  /** Injected so a test never touches the network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Total budget for the whole walk, not per hop. */
  timeoutMs?: number;
  maxHops?: number;
}

export interface FetchOutcome {
  /** The URL originally asked for. */
  requestedUrl: string;
  /** The URL the body actually came from — the model's window onto the hops. */
  finalUrl: string;
  /** Every URL that produced a 3xx, in order. */
  hops: readonly string[];
  status: number;
  statusText: string;
  contentType: string;
  elapsedMs: number;
  body: string;
}

/**
 * GETs a URL, following redirects by hand, and returns the body as text.
 *
 * ## Why the redirect loop is ours
 *
 * `redirect: "follow"` plus a discarded `res.url` is a redirect chain nobody can
 * see and, worse, one whose *credentials* follow it: the header set for hop 0 is
 * the header set for hop 5, and a hop that leaves the allowlist takes the token
 * with it. So redirects are followed manually, each hop's authorization is
 * recomputed from that hop's URL, and the final URL is returned rather than
 * dropped on the floor.
 *
 * `redirect: "manual"` in Node (undici) hands back the real 3xx with a readable
 * `Location`, which is what makes the walk possible at all. In a *browser* the
 * same mode yields an opaqueness-filtered response with status 0 and no headers,
 * so this function is Node-only — which is fine, it is a terminal agent, and the
 * module already depends on `node:child_process` transitively through `auth.ts`.
 *
 * ## Why the timeout is one signal
 *
 * A single `AbortSignal.timeout` is created for the whole walk, so five hops
 * cannot buy five times the budget. A per-hop timeout would make the bound on
 * hops and the bound on time independent, and the caller only sets the latter.
 *
 * No error constructed here mentions the token or the header value. The token is
 * never in a message because it is never in a template — it exists only inside
 * the header map, which is not interpolated into anything.
 */
export async function fetchUrlText(rawUrl: string, opts: FetchUrlOptions = {}): Promise<FetchOutcome> {
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;
  const send = opts.fetchImpl ?? fetch;
  const start = Date.now();

  const requested = new URL(rawUrl);
  // Resolved once: the credential does not change mid-walk, and re-running the
  // resolver per hop would shell out to `gh` five times for one fetch.
  const auth = resolveGitHubAuth();
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const hops: string[] = [];
  let current = requested;

  for (;;) {
    const res = await send(current.href, {
      signal,
      // Not "follow": the walk below is the follow, and it is the only thing
      // that can notice a hop changed host.
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, ...authHeadersFor(current.href, auth) },
    });

    if (!REDIRECT_STATUSES.has(res.status)) {
      return {
        requestedUrl: requested.href,
        finalUrl: current.href,
        hops,
        status: res.status,
        statusText: res.statusText,
        contentType: res.headers.get("content-type") ?? "unknown",
        elapsedMs: Date.now() - start,
        body: await res.text(),
      };
    }

    if (hops.length >= maxHops) {
      throw new Error(`too many redirects: gave up after ${String(maxHops)} hop(s) from ${requested.href}`);
    }

    const location = res.headers.get("location");
    if (location === null) {
      throw new Error(`${String(res.status)} from ${current.href} carried no Location header`);
    }

    let next: URL;
    try {
      // Relative Locations are legal and common; resolving against the hop that
      // produced them is what makes "../raw/main/SKILL.md" work.
      next = new URL(location, current);
    } catch {
      throw new Error(`${String(res.status)} from ${current.href} carried an unusable Location header`);
    }

    if (next.protocol !== "https:") {
      // Scheme and host only. A `Location` is server-controlled, and echoing a
      // whole one back into an error is a free channel for putting something
      // credential-shaped into a model transcript; the host is what identifies
      // the downgrade, and that is all the model needs.
      throw new Error(
        `refusing to follow a redirect from ${current.href} that leaves https: (${next.protocol}//${next.host})`,
      );
    }

    hops.push(current.href);
    current = next;
  }
}

function clip(body: string): string {
  if (body.length <= MAX_TOOL_OUTPUT) return body;
  return `${body.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated ${String(body.length - MAX_TOOL_OUTPUT)} chars]`;
}

function render(outcome: FetchOutcome): string {
  const lines = [
    `status ${String(outcome.status)} ${outcome.statusText} · ${String(outcome.elapsedMs)}ms · content-type ${outcome.contentType}`,
  ];
  const hint = rateLimitHint(outcome.status);
  if (hint !== undefined) lines.push(hint);
  lines.push(`final-url ${outcome.finalUrl}`);
  if (outcome.hops.length > 0) {
    lines.push(`redirects ${String(outcome.hops.length)}: ${outcome.hops.join(" → ")} → ${outcome.finalUrl}`);
  }
  return `${lines.join("\n")}\n${clip(outcome.body)}`;
}

async function fetchTool(args: unknown, _ctx: ToolContext): Promise<string> {
  const { url, timeoutMs } = fetchSchema.parse(args);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("only http(s) URLs are allowed");
  }
  return render(await fetchUrlText(url, { timeoutMs }));
}

export const webTools: ToolDefinition[] = [
  {
    name: "fetch_url",
    description:
      "GET an http(s) URL and return its body as text. Up to 5 redirects are followed, each hop re-checked for host, and the final URL is reported.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "absolute http(s) URL" },
        timeoutMs: { type: "integer", description: "timeout in ms for the whole request (default 15000, max 60000)" },
      },
      required: ["url"],
    },
    schema: fetchSchema,
    run: fetchTool,
  },
];
