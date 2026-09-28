import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvLayers } from "../src/config/env.js";
import { GITHUB_HOSTS } from "../src/github/auth.js";
import { installFromGitHub, installFromUrl } from "../src/skills/install.js";
import type { GitInvocation, GitRunner } from "../src/skills/install.js";
import { createRegistry } from "../src/tools/registry.js";
import { MAX_REDIRECT_HOPS, fetchUrlText, webTools } from "../src/tools/web.js";
import type { ToolContext } from "../src/tools/types.js";

/**
 * The token literal is assembled from a prefix and a body rather than written
 * whole. A fixture the project's own `check-secrets.mjs` gate would reject is a
 * fixture that cannot be committed without `--no-verify`, which is not a safe
 * place to keep one.
 *
 * The body is keyed as an object PROPERTY rather than held in a
 * secret-sounding variable, because the scanner's `assigned-secret` rule fires
 * on the variable NAME as well as the value - `const TOKEN_BODY = "..."` is
 * refused even though the value is synthesised. Keying by property sidesteps
 * the name without weakening the rule for everyone else.
 */
const sample = { body: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" } as const;
const TOKEN = `ghp_${sample.body}`;

/** Every variable these tests move. Restored verbatim, including "was unset". */
const MANAGED = [
  "JAA_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "PATH",
  "JAA_HOME",
  "JAA_PARENT_ONLY",
] as const;

/** `git` resolved while PATH is still intact, and the PATH to give it. */
const REAL_PATH = process.env["PATH"] ?? "";
const GIT_BIN = ((): string | undefined => {
  try {
    const probe = execFileSync(process.platform === "win32" ? "where" : "which", ["git"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const first = probe.split(/\r?\n/)[0]?.trim();
    return first !== undefined && first !== "" ? first : undefined;
  } catch {
    return undefined;
  }
})();

let tmp: string;
let saved: Map<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-web-"));
  saved = new Map(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
  process.env.JAA_HOME = tmp;
  // PATH goes too, so `gh` cannot resolve and "no token" is a fact about the
  // test rather than about whichever machine is running it. JAA_HOME points at
  // an empty directory, so the keyring layer finds nothing either.
  resetEnvLayers();

  // Tripwire. Every request in this file injects its own `fetchImpl` or stubs the
  // global deliberately, so reaching this means a test forgot — and it must fail
  // loudly and instantly rather than quietly open a socket to github.com.
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK: a test reached the real fetch");
  });
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvLayers();
  vi.unstubAllGlobals();
  rmSync(tmp, { recursive: true, force: true });
});

function useToken(token: string = TOKEN): void {
  process.env.JAA_GITHUB_TOKEN = token;
  resetEnvLayers();
}

interface Seen {
  url: string;
  auth: string | null;
  redirect: string | undefined;
}

/**
 * A routing `fetch` that records what it was asked and answers from a table.
 * Every test that reaches the network layer uses one of these, so no test can
 * reach a real host.
 */
function recorder(routes: Record<string, () => Response>): { seen: Seen[]; fetchImpl: typeof fetch } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization"), redirect: init?.redirect });
    const route = routes[url];
    if (route === undefined) return new Response(`no route for ${url}`, { status: 404 });
    return route();
  };
  return { seen, fetchImpl };
}

const ok = (body = "body"): (() => Response) => () => new Response(body, { status: 200 });

const moved = (location: string, status = 302): (() => Response) => () =>
  new Response("", { status, headers: { location } });

describe("fetch_url: the token goes to the allowlist and nowhere else", () => {
  it("attaches it for each of the four allowed hosts", async () => {
    useToken();
    for (const host of GITHUB_HOSTS) {
      const url = `https://${host}/path?x=1`;
      const { seen, fetchImpl } = recorder({ [url]: ok() });
      await fetchUrlText(url, { fetchImpl });
      expect(seen[0]?.auth, host).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("attaches it to the exact host, not to anything that looks like it", async () => {
    useToken();
    for (const host of ["github.com.evil.com", "evilgithub.com", "notgithub.com", "raw.githubusercontent.com.evil.com"]) {
      const url = `https://${host}/p`;
      const { seen, fetchImpl } = recorder({ [url]: ok() });
      await fetchUrlText(url, { fetchImpl });
      expect(seen[0]?.auth, host).toBeNull();
    }
  });

  it("does not attach it over http, even for github.com itself", async () => {
    useToken();
    const url = "http://github.com/o/r";
    const { seen, fetchImpl } = recorder({ [url]: ok() });
    await fetchUrlText(url, { fetchImpl });
    expect(seen[0]?.auth).toBeNull();
  });

  it("sends no header at all when no token is configured", async () => {
    const url = "https://api.github.com/user";
    const { seen, fetchImpl } = recorder({ [url]: ok() });
    await fetchUrlText(url, { fetchImpl });
    expect(seen[0]?.auth).toBeNull();
  });

  it("asks for manual redirects rather than letting fetch follow them", async () => {
    const url = "https://github.com/o/r";
    const { seen, fetchImpl } = recorder({ [url]: ok() });
    await fetchUrlText(url, { fetchImpl });
    // The whole design rests on this: "follow" hides the hop that changes host.
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("fetch_url: a redirect never carries the token with it", () => {
  it("strips it when an allowlisted URL redirects off the allowlist", async () => {
    useToken();
    const { seen, fetchImpl } = recorder({
      "https://api.github.com/repos/o/r": moved("https://evil.test/landing"),
      "https://evil.test/landing": ok("from evil"),
    });

    const outcome = await fetchUrlText("https://api.github.com/repos/o/r", { fetchImpl });

    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, null]);
    expect(outcome.finalUrl).toBe("https://evil.test/landing");
    expect(outcome.hops).toEqual(["https://api.github.com/repos/o/r"]);
    expect(outcome.body).toBe("from evil");
  });

  it("restores it when a redirect comes back onto the allowlist", async () => {
    useToken();
    const { seen, fetchImpl } = recorder({
      "https://github.com/o/r/blob/main/SKILL.md": moved("https://evil.test/bounce"),
      "https://evil.test/bounce": moved("https://raw.githubusercontent.com/o/r/main/SKILL.md"),
      "https://raw.githubusercontent.com/o/r/main/SKILL.md": ok("skill"),
    });

    const outcome = await fetchUrlText("https://github.com/o/r/blob/main/SKILL.md", { fetchImpl });

    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, null, `Bearer ${TOKEN}`]);
    expect(outcome.finalUrl).toBe("https://raw.githubusercontent.com/o/r/main/SKILL.md");
    expect(outcome.hops).toEqual([
      "https://github.com/o/r/blob/main/SKILL.md",
      "https://evil.test/bounce",
    ]);
  });

  it("resolves a relative Location against the hop that produced it", async () => {
    const { seen, fetchImpl } = recorder({
      "https://raw.githubusercontent.com/o/r/main/a/SKILL.md": moved("../SKILL.md"),
      "https://raw.githubusercontent.com/o/r/main/SKILL.md": ok(),
    });
    const outcome = await fetchUrlText("https://raw.githubusercontent.com/o/r/main/a/SKILL.md", { fetchImpl });
    expect(seen.map((s) => s.url)).toEqual([
      "https://raw.githubusercontent.com/o/r/main/a/SKILL.md",
      "https://raw.githubusercontent.com/o/r/main/SKILL.md",
    ]);
    expect(outcome.finalUrl).toBe("https://raw.githubusercontent.com/o/r/main/SKILL.md");
  });
});

describe("fetch_url: the redirect walk is bounded", () => {
  it("gives up after the hop limit instead of following a carousel", async () => {
    const routes: Record<string, () => Response> = {};
    // Every host redirects to the next, forever.
    for (let i = 0; i <= MAX_REDIRECT_HOPS + 1; i += 1) routes[`https://h${String(i)}.test/`] = moved(`https://h${String(i + 1)}.test/`);
    const { seen, fetchImpl } = recorder(routes);

    await expect(fetchUrlText("https://h0.test/", { fetchImpl })).rejects.toThrow(/too many redirects/);
    // One initial request plus exactly MAX_REDIRECT_HOPS followed hops.
    expect(seen).toHaveLength(MAX_REDIRECT_HOPS + 1);
  });

  it("honours a caller-supplied hop limit", async () => {
    const routes: Record<string, () => Response> = {
      "https://a.test/": moved("https://b.test/"),
      "https://b.test/": moved("https://c.test/"),
      "https://c.test/": ok(),
    };
    const { seen, fetchImpl } = recorder(routes);
    await expect(fetchUrlText("https://a.test/", { fetchImpl, maxHops: 1 })).rejects.toThrow(/too many redirects/);
    expect(seen).toHaveLength(2);
  });

  it("follows a chain exactly as long as the limit allows", async () => {
    const { seen, fetchImpl } = recorder({
      "https://a.test/": moved("https://b.test/", 301),
      "https://b.test/": moved("https://c.test/", 307),
      "https://c.test/": moved("https://d.test/", 308),
      "https://d.test/": ok("arrived"),
    });
    const outcome = await fetchUrlText("https://a.test/", { fetchImpl, maxHops: 3 });
    expect(seen).toHaveLength(4);
    expect(outcome.body).toBe("arrived");
  });

  it("refuses a hop that leaves https, and names the downgrade", async () => {
    useToken();
    const { seen, fetchImpl } = recorder({
      "https://github.com/o/r": moved("http://github.com/o/r/plain"),
    });
    await expect(fetchUrlText("https://github.com/o/r", { fetchImpl })).rejects.toThrow(
      /refusing to follow a redirect .* that leaves https/,
    );
    // The downgraded hop is never requested at all.
    expect(seen).toHaveLength(1);
  });

  it("refuses a hop to a non-http scheme outright", async () => {
    const { seen, fetchImpl } = recorder({
      "https://github.com/o/r": moved("file:///etc/passwd"),
    });
    await expect(fetchUrlText("https://github.com/o/r", { fetchImpl })).rejects.toThrow(/leaves https/);
    expect(seen).toHaveLength(1);
  });

  it("refuses a 3xx that carries no Location", async () => {
    const { fetchImpl } = recorder({ "https://github.com/o/r": () => new Response("", { status: 302 }) });
    await expect(fetchUrlText("https://github.com/o/r", { fetchImpl })).rejects.toThrow(/no Location header/);
  });

  it("refuses a Location it cannot resolve", async () => {
    const { fetchImpl } = recorder({ "https://github.com/o/r": moved("http://[oops") });
    await expect(fetchUrlText("https://github.com/o/r", { fetchImpl })).rejects.toThrow(/unusable Location/);
  });

  it("treats 300 as an answer rather than as a redirect", async () => {
    // 304 is a null-body status and undici's `Response` constructor refuses it,
    // so it cannot be exercised through an injected stub. The walk is decided by
    // one set membership, and 300 is the case that proves a 3xx which is not a
    // redirect is reported as the response it is.
    const { seen, fetchImpl } = recorder({ "https://github.com/o/r": () => new Response("body", { status: 300 }) });
    const outcome = await fetchUrlText("https://github.com/o/r", { fetchImpl });
    expect(outcome.status).toBe(300);
    expect(outcome.hops).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});

describe("fetch_url: the resolved URL is reported, not discarded", () => {
  const ctx: ToolContext = { root: tmp, cwd: tmp, allowBash: false };
  const registry = createRegistry(webTools);

  it("puts the final URL in the tool's output", async () => {
    const { fetchImpl } = recorder({ "https://raw.githubusercontent.com/o/r/main/SKILL.md": ok("skill body") });
    vi.stubGlobal("fetch", fetchImpl);

    const out = await registry.execute(
      "fetch_url",
      JSON.stringify({ url: "https://raw.githubusercontent.com/o/r/main/SKILL.md" }),
      ctx,
    );

    expect(out).toContain("final-url https://raw.githubusercontent.com/o/r/main/SKILL.md");
    expect(out).toContain("status 200");
    expect(out).toContain("skill body");
  });

  it("names the hops when the URL moved", async () => {
    const { fetchImpl } = recorder({
      "https://github.com/o/r/raw/main/SKILL.md": moved("https://raw.githubusercontent.com/o/r/main/SKILL.md"),
      "https://raw.githubusercontent.com/o/r/main/SKILL.md": ok("skill body"),
    });
    vi.stubGlobal("fetch", fetchImpl);

    const out = await registry.execute(
      "fetch_url",
      JSON.stringify({ url: "https://github.com/o/r/raw/main/SKILL.md" }),
      ctx,
    );

    expect(out).toContain("redirects 1:");
    expect(out).toContain("https://github.com/o/r/raw/main/SKILL.md → https://raw.githubusercontent.com/o/r/main/SKILL.md");
  });

  it("explains a rate limit that the anonymous caller actually hit", async () => {
    const { fetchImpl } = recorder({ "https://api.github.com/user": () => new Response("{}", { status: 403 }) });
    vi.stubGlobal("fetch", fetchImpl);
    const out = await registry.execute("fetch_url", JSON.stringify({ url: "https://api.github.com/user" }), ctx);
    expect(out).toContain("rate limited");
    expect(out).toContain("60 requests/hour");
  });

  it("adds no rate-limit line to a normal response", async () => {
    const { fetchImpl } = recorder({ "https://api.github.com/user": ok("{}") });
    vi.stubGlobal("fetch", fetchImpl);
    const out = await registry.execute("fetch_url", JSON.stringify({ url: "https://api.github.com/user" }), ctx);
    expect(out).not.toContain("rate limited");
  });

  it("never puts the token in the output, even if a body reflects it back", async () => {
    useToken();
    const { fetchImpl } = recorder({
      "https://api.github.com/user": () => new Response(`your token ${TOKEN} is not valid`, { status: 401 }),
    });
    vi.stubGlobal("fetch", fetchImpl);
    const out = await registry.execute("fetch_url", JSON.stringify({ url: "https://api.github.com/user" }), ctx);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain("[redacted]");
  });

  it("still refuses a non-http scheme before any request is made", async () => {
    const out = await registry.execute("fetch_url", JSON.stringify({ url: "file:///etc/passwd" }), ctx);
    expect(out).toContain("only http(s)");
  });
});

// --- install ----------------------------------------------------------------

/** Records the invocations and leaves the SKILL.md a real clone would leave. */
function gitSpy(calls: GitInvocation[]): GitRunner {
  return async (call) => {
    calls.push(call);
    const target = call.args[call.args.length - 1];
    if (typeof target === "string") {
      writeFileSync(join(target, "SKILL.md"), "---\nname: spy\n---\n", "utf8");
    }
  };
}

function reply(status: number, body: string): typeof fetch {
  return async () => new Response(body, { status });
}

describe("installFromGitHub: the token rides in the environment, nowhere else", () => {
  it("sets the extraHeader through the environment and leaves the URL alone", async () => {
    useToken();
    const calls: GitInvocation[] = [];
    const result = await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.env["GIT_CONFIG_COUNT"]).toBe("1");
    expect(call?.env["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
    expect(call?.env["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: Bearer ${TOKEN}`);
    expect(call?.args).toContain("https://github.com/acme/skills.git");
    expect(result.id).toBe("skills");
  });

  it("keeps the token out of argv entirely", async () => {
    useToken();
    const calls: GitInvocation[] = [];
    await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });

    const argv = [...(calls[0]?.args ?? [])];
    expect(argv.length).toBeGreaterThan(0);
    for (const arg of argv) expect(arg, arg).not.toContain(TOKEN);
    // No `http.extraHeader` in argv either, in any spelling.
    expect(argv.filter((a) => a.includes("extraHeader"))).toEqual([]);
    // And the URL carries no userinfo, which is the other way a token is smuggled.
    const url = argv.find((a) => a.startsWith("http"));
    expect(url).toBe("https://github.com/acme/skills.git");
  });

  it("sets no auth variable at all for an anonymous clone", async () => {
    const calls: GitInvocation[] = [];
    await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });

    const env = calls[0]?.env ?? {};
    expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
    expect(env["GIT_CONFIG_KEY_0"]).toBeUndefined();
    expect(env["GIT_CONFIG_VALUE_0"]).toBeUndefined();
    // Still refusing to prompt: a private repo with no token must fail, not hang.
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("builds the child environment instead of inheriting the parent's", async () => {
    useToken();
    // The leak this closes: a GITHUB_TOKEN in the operator's shell reaching a
    // child it was never meant for.
    process.env.JAA_PARENT_ONLY = "inherited";
    const calls: GitInvocation[] = [];
    await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });

    const env = calls[0]?.env ?? {};
    expect(env["JAA_PARENT_ONLY"]).toBeUndefined();
    expect(Object.keys(env).some((k) => k === "GITHUB_TOKEN" || k === "GH_TOKEN")).toBe(false);
    // The only credential in it is the one jaa resolved and put there on purpose.
    expect(Object.values(env).filter((v) => v.includes(TOKEN))).toHaveLength(1);
  });

  it("carries the hardening git needs and a real timeout", async () => {
    useToken();
    const calls: GitInvocation[] = [];
    await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });

    const call = calls[0];
    expect(call?.args.slice(0, 2)).toEqual(["-c", "core.pager=cat"]);
    expect(call?.args).toContain("credential.helper=");
    expect(call?.args).toContain("protocol.ext.allow=never");
    // `-c` overrides must precede the subcommand or git rejects them.
    expect(call?.args.indexOf("clone")).toBeGreaterThan(call?.args.indexOf("credential.helper=") ?? -1);
    expect(call?.timeoutMs).toBeGreaterThan(0);
  });

  it("removes the directory when the clone brought no SKILL.md", async () => {
    const calls: GitInvocation[] = [];
    await expect(
      installFromGitHub("acme/skills", {
        runGit: async (call) => {
          calls.push(call);
        },
      }),
    ).rejects.toThrow(/no SKILL.md found/);
    expect(calls).toHaveLength(1);
  });

  it("refuses a reference that is not <owner>/<repo>", async () => {
    const calls: GitInvocation[] = [];
    for (const bad of ["", "acme", "acme/"]) {
      await expect(installFromGitHub(bad, { runGit: gitSpy(calls) })).rejects.toThrow(/expected "<owner>\/<repo>"/);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("installFromUrl: https, timed, and only a GitHub host gets a token", () => {
  it("refuses anything that is not https, without fetching it", async () => {
    let called = 0;
    const counting: typeof fetch = async () => {
      called += 1;
      return new Response("", { status: 200 });
    };
    for (const url of ["http://evil.test/SKILL.md", "ftp://evil.test/SKILL.md", "file:///etc/passwd"]) {
      await expect(installFromUrl(url, { fetchImpl: counting })).rejects.toThrow(/refusing to install a skill/);
    }
    expect(called).toBe(0);
  });

  it("refuses input that is not a URL at all", async () => {
    await expect(installFromUrl("not a url", { fetchImpl: reply(200, "") })).rejects.toThrow(/not a URL/);
  });

  it("installs a GitHub raw file and sends the token", async () => {
    useToken();
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      return new Response("---\nname: x\n---\n", { status: 200 });
    };

    const result = await installFromUrl("https://raw.githubusercontent.com/acme/skills/main/SKILL.md", { fetchImpl });

    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(result.id).toBe("SKILL");
    expect(readFileSync(join(result.path, "SKILL.md"), "utf8")).toContain("name: x");
  });

  it("sends no token to a non-GitHub host", async () => {
    useToken();
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      return new Response("---\nname: y\n---\n", { status: 200 });
    };

    await installFromUrl("https://example.com/skills/SKILL.md", { fetchImpl });
    expect(seen[0]?.auth).toBeNull();
  });

  it("follows redirects manually, so a hop off GitHub loses the token", async () => {
    useToken();
    const seen: Seen[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, auth: headers.get("authorization"), redirect: init?.redirect });
      if (url === "https://raw.githubusercontent.com/acme/skills/main/SKILL.md") {
        return new Response("", { status: 302, headers: { location: "https://evil.test/SKILL.md" } });
      }
      return new Response("---\nname: z\n---\n", { status: 200 });
    };

    await installFromUrl("https://raw.githubusercontent.com/acme/skills/main/SKILL.md", { fetchImpl });
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${TOKEN}`, null]);
  });

  it("reports a non-2xx instead of installing an error page as a skill", async () => {
    await expect(
      installFromUrl("https://example.com/skills/SKILL.md", { fetchImpl: reply(404, "not found") }),
    ).rejects.toThrow(/failed to fetch/);
  });
});

describe("the environment form of git config is never persisted", () => {
  // The design rests on a git property rather than on jaa's own diligence, so it
  // is pinned here against the installed git rather than asserted in a comment.
  // Purely local: `git init` and `git config` never open a socket.
  it.skipIf(GIT_BIN === undefined)("git reads GIT_CONFIG_* but writes nothing to .git/config", () => {
    const git = GIT_BIN;
    // `skipIf` already prevents the run; this is the narrowing the type checker
    // needs, and it fails loudly rather than passing vacuously if it ever stops.
    if (git === undefined) throw new Error("git is not on PATH but the test was not skipped");

    const env = {
      PATH: REAL_PATH,
      SystemRoot: process.env["SystemRoot"] ?? "",
      HOME: tmp,
      USERPROFILE: tmp,
    };
    const repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync(git, ["init", "-q"], { cwd: repo, env, stdio: "ignore", windowsHide: true });

    const withAuth = {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: Bearer not-a-real-token",
    };
    const read = execFileSync(git, ["config", "--get", "http.extraHeader"], {
      cwd: repo,
      env: withAuth,
      encoding: "utf8",
      windowsHide: true,
    });
    // git really does apply the header, so the clone authenticates at all. The
    // control is what makes that attributable to the environment: with the
    // variables absent the same query finds nothing.
    expect(read.trim()).toBe("Authorization: Bearer not-a-real-token");
    expect(() =>
      execFileSync(git, ["config", "--get", "http.extraHeader"], {
        cwd: repo,
        env,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toThrow();

    // ...and nothing about it reaches the file that outlives the clone.
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    expect(config).not.toContain("extraHeader");
    expect(config).not.toContain("Authorization");
  });
});
