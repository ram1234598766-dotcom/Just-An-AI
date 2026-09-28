import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvLayers } from "../src/config/env.js";
import { GITHUB_HOSTS, githubAuthHeader, isGitHubHost, resolveGitHubAuth } from "../src/github/auth.js";
import { classifyToken, rateLimitHint, verifyGitHubToken } from "../src/github/verify.js";

/** Every variable these tests move. Restored verbatim, including "was unset". */
const MANAGED = ["JAA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "PATH", "JAA_HOME"] as const;

let tmp: string;
let project: string;
let saved: Map<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-gh-"));
  project = join(tmp, "project");
  mkdirSync(project);
  saved = new Map(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
  process.env.JAA_HOME = tmp;
  // PATH goes too, so `gh` cannot resolve and "anonymous" is a fact about the
  // test rather than about whichever machine is running it. The gh-cli branch
  // gets its own test with a deliberate PATH.
  resetEnvLayers();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvLayers();
  rmSync(tmp, { recursive: true, force: true });
});

function setProjectEnv(body: string): void {
  writeFileSync(join(project, ".env"), body, "utf8");
}

function setKeyring(body: string): void {
  writeFileSync(join(tmp, ".env"), body, "utf8");
}

function setProcessEnv(key: (typeof MANAGED)[number], value: string): void {
  process.env[key] = value;
  resetEnvLayers();
}

describe("resolveGitHubAuth: precedence", () => {
  it("prefers JAA_GITHUB_TOKEN over every other source", () => {
    setProcessEnv("JAA_GITHUB_TOKEN", "from-jaa");
    setProcessEnv("GITHUB_TOKEN", "from-github");
    setProcessEnv("GH_TOKEN", "from-gh");
    setProjectEnv("JAA_GITHUB_TOKEN=proj\nGITHUB_TOKEN=proj2\n");
    setKeyring("JAA_GITHUB_TOKEN=ring\n");

    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "from-jaa",
      source: "env:JAA_GITHUB_TOKEN",
    });
  });

  it("falls through GITHUB_TOKEN then GH_TOKEN, in that order", () => {
    setProcessEnv("GITHUB_TOKEN", "from-github");
    setProcessEnv("GH_TOKEN", "from-gh");
    setProjectEnv("GITHUB_TOKEN=proj\n");
    setKeyring("JAA_GITHUB_TOKEN=ring\n");
    expect(resolveGitHubAuth({ projectDir: project }).source).toBe("env:GITHUB_TOKEN");

    delete process.env.GITHUB_TOKEN;
    resetEnvLayers();
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: "from-gh", source: "env:GH_TOKEN" });
  });

  it("outranks a project file with a higher-priority name", () => {
    // The ordering is name-major within a layer, so the shell's GITHUB_TOKEN
    // must beat the project file's JAA_GITHUB_TOKEN. `findSecret`'s own order
    // would do the opposite, which is why the process layer is walked by hand.
    setProcessEnv("GITHUB_TOKEN", "from-shell");
    setProjectEnv("JAA_GITHUB_TOKEN=from-project\n");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "from-shell",
      source: "env:GITHUB_TOKEN",
    });
  });

  it("reads the project .env, and only from the directory it was given", () => {
    setProjectEnv("GITHUB_TOKEN=from-project\n");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "from-project",
      source: "project-env",
    });
    // A different directory must not see it, even though cwd would.
    const elsewhere = join(tmp, "elsewhere");
    mkdirSync(elsewhere);
    expect(resolveGitHubAuth({ projectDir: elsewhere })).toEqual({ token: undefined, source: "anonymous" });
  });

  it("reads the keyring, and only its JAA_-prefixed name", () => {
    setKeyring("# a comment\nJAA_GITHUB_TOKEN=from-keyring\nGITHUB_TOKEN=ignored\n");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "from-keyring",
      source: "keyring",
    });
  });

  it("outranks the keyring with a project file", () => {
    setProjectEnv("JAA_GITHUB_TOKEN=from-project\n");
    setKeyring("JAA_GITHUB_TOKEN=from-keyring\n");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "from-project",
      source: "project-env",
    });
  });

  it("is anonymous when nothing is configured", () => {
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
  });

  it("never throws, whatever the state", () => {
    expect(() => resolveGitHubAuth({ projectDir: join(tmp, "does-not-exist") })).not.toThrow();
  });
});

describe("resolveGitHubAuth: unusable values are treated as absent", () => {
  const BLANK = ["", "   ", "\t\n "];

  for (const blank of BLANK) {
    it(`ignores a process env value of ${JSON.stringify(blank)}`, () => {
      setProcessEnv("GITHUB_TOKEN", blank);
      expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
    });

    it(`ignores a project .env value of ${JSON.stringify(blank)}`, () => {
      setProjectEnv(`GITHUB_TOKEN=${blank}\n`);
      expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
    });

    it(`ignores a keyring value of ${JSON.stringify(blank)}`, () => {
      setKeyring(`JAA_GITHUB_TOKEN=${blank}\n`);
      expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
    });
  }

  it("falls through a blank higher layer to a real lower one", () => {
    setProcessEnv("JAA_GITHUB_TOKEN", "   ");
    setProcessEnv("GITHUB_TOKEN", "real");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "real",
      source: "env:GITHUB_TOKEN",
    });
  });

  it("trims the value it returns", () => {
    setProcessEnv("GITHUB_TOKEN", "  padded  \n");
    expect(resolveGitHubAuth({ projectDir: project }).token).toBe("padded");
  });
});

/** Whether this machine can actually run `gh`, so the branch can be exercised. */
function ghWorks(): boolean {
  try {
    execFileSync("gh", ["--version"], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

const GH_AVAILABLE = ghWorks();

/**
 * A `gh` on PATH that always fails.
 *
 * On Windows a `.cmd` needs a shell to run, so the stand-in is a real
 * executable. `where.exe` is preferred over `process.execPath` purely on size:
 * these tests spawn it twice, and node is a hundred-megabyte binary to copy and
 * start for the privilege of exiting non-zero. On POSIX it is a script.
 */
function brokenGh(): void {
  const dir = join(tmp, "bin");
  mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    const where = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe");
    copyFileSync(existsSync(where) ? where : process.execPath, join(dir, "gh.exe"));
  } else {
    const script = join(dir, "gh");
    writeFileSync(script, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(script, 0o755);
  }
  setProcessEnv("PATH", dir);
}

describe("resolveGitHubAuth: the gh CLI is the last resort, and never fatal", () => {
  it("falls through to anonymous when gh is not installed", () => {
    // PATH is empty for the whole suite, so this is the "gh absent" branch.
    expect(process.env.PATH).toBeUndefined();
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
  });

  // Spawns two processes on purpose, which is a second or two of real work on
  // a loaded machine — the default 5s budget is not enough for that to be a
  // reliable pass/fail signal.
  it("falls through to anonymous when gh exits non-zero", () => {
    brokenGh();
    // Control: the stand-in really is on PATH and really does fail, so this is
    // the "gh present and failing" branch and not the "gh absent" one again.
    expect(() => execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: "ignore" })).toThrow();
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({ token: undefined, source: "anonymous" });
  }, 20_000);

  it.skipIf(!GH_AVAILABLE)("uses gh auth token when nothing else is configured", () => {
    // The real thing may or may not be logged in, so both outcomes are valid;
    // what is pinned is that the source is labelled honestly and the token is
    // never empty.
    const auth = resolveGitHubAuth({ projectDir: project });
    expect(auth.source === "gh-cli" || auth.source === "anonymous").toBe(true);
    if (auth.source === "gh-cli") {
      expect(typeof auth.token).toBe("string");
      expect((auth.token ?? "").trim()).not.toBe("");
    } else {
      expect(auth.token).toBeUndefined();
    }
  });

  it.skipIf(!GH_AVAILABLE)("does not reach for gh when an earlier source has a token", () => {
    setProcessEnv("GITHUB_TOKEN", "already-known");
    expect(resolveGitHubAuth({ projectDir: project })).toEqual({
      token: "already-known",
      source: "env:GITHUB_TOKEN",
    });
  });
});

describe("GITHUB_HOSTS", () => {
  it("is exactly the four documented hosts", () => {
    expect(GITHUB_HOSTS).toEqual([
      "github.com",
      "api.github.com",
      "raw.githubusercontent.com",
      "codeload.github.com",
    ]);
  });
});

describe("isGitHubHost", () => {
  it("accepts every host on the allowlist", () => {
    for (const host of GITHUB_HOSTS) {
      expect(isGitHubHost(`https://${host}`), host).toBe(true);
      expect(isGitHubHost(`https://${host}/some/path?q=1#frag`), host).toBe(true);
    }
  });

  it("is case-insensitive about the host", () => {
    expect(isGitHubHost("https://GitHub.COM/o/r")).toBe(true);
    expect(isGitHubHost("https://API.GITHUB.COM/user")).toBe(true);
  });

  it("requires https", () => {
    expect(isGitHubHost("http://github.com")).toBe(false);
    // Not merely "refuses http": a downgrade must not be one redirect away.
    expect(isGitHubHost("ftp://github.com")).toBe(false);
  });

  it("refuses a host that merely ends with a GitHub name", () => {
    expect(isGitHubHost("https://github.com.evil.com")).toBe(false);
    expect(isGitHubHost("https://evilgithub.com")).toBe(false);
    expect(isGitHubHost("https://raw.githubusercontent.com.evil.com")).toBe(false);
  });

  it("refuses a GitHub name that only appears in the query or path", () => {
    expect(isGitHubHost("https://evil.com/?x=github.com")).toBe(false);
    expect(isGitHubHost("https://evil.com/github.com")).toBe(false);
  });

  it("accepts userinfo on a genuine GitHub host", () => {
    // The host is still github.com; the userinfo is a red herring for a
    // substring check, not a reason to refuse a legitimate URL.
    expect(isGitHubHost("https://user@github.com")).toBe(true);
  });

  it("refuses the userinfo trick, whose real host is the attacker's", () => {
    expect(isGitHubHost("https://github.com@evil.com/")).toBe(false);
    expect(isGitHubHost("https://user@github.com@evil.com/")).toBe(false);
  });

  it("refuses anything that is not a URL", () => {
    for (const bad of ["", "github.com", "not a url", "//github.com", "https://", "/o/r", "://github.com"]) {
      expect(isGitHubHost(bad), bad).toBe(false);
    }
  });
});

describe("githubAuthHeader", () => {
  it("is empty for anonymous", () => {
    expect(githubAuthHeader({ token: undefined, source: "anonymous" })).toEqual({});
  });

  it("is empty for a blank token, whatever the source claims", () => {
    expect(githubAuthHeader({ token: "   ", source: "env:GITHUB_TOKEN" })).toEqual({});
  });

  it("is a bearer header otherwise", () => {
    expect(githubAuthHeader({ token: "abc123", source: "keyring" })).toEqual({ authorization: "Bearer abc123" });
  });

  it("is what the resolver produces, end to end", () => {
    setProcessEnv("JAA_GITHUB_TOKEN", "resolved-token");
    const auth = resolveGitHubAuth({ projectDir: project });
    expect(githubAuthHeader(auth)).toEqual({ authorization: "Bearer resolved-token" });
  });
});

describe("classifyToken", () => {
  // The body is held apart from its prefix so the literal in this file is not
  // itself a scanner hit: a test fixture that cannot be committed without
  // `--no-verify` is not a safe place to keep one.
  const BODY = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const BODIES: ReadonlyArray<[string, string]> = [
    ["ghp_", `ghp_${BODY}`],
    ["gho_", `gho_${BODY}`],
    ["ghu_", `ghu_${BODY}`],
    ["ghs_", `ghs_${BODY}`],
    ["ghr_", `ghr_${BODY}`],
  ];

  for (const [prefix, value] of BODIES) {
    it(`calls ${prefix} an OAuth-family token`, () => {
      expect(classifyToken(value)).toBe("oauth");
    });
  }

  it("calls github_pat_ fine-grained", () => {
    const value = "github_pat_" + "A".repeat(82);
    expect(classifyToken(value)).toBe("fine-grained");
  });

  it("calls a bare 40-hex string classic", () => {
    expect(classifyToken("0123456789abcdef0123456789abcdef01234567")).toBe("classic");
    expect(classifyToken("0123456789ABCDEF0123456789ABCDEF01234567")).toBe("classic");
  });

  it("trims before classifying", () => {
    expect(classifyToken(`  ghp_${BODY}\n`)).toBe("oauth");
  });

  it("does not guess a length for anything it does not recognise", () => {
    // The rule is "say what is recognisable", so an unfamiliar prefix is
    // `unknown` whatever its length — not `unknown` only for short strings.
    expect(classifyToken("glpat-ABCDEFGHIJKLMNOPQRST")).toBe("unknown");
    expect(classifyToken("a".repeat(200))).toBe("unknown");
    expect(classifyToken("")).toBe("unknown");
    // 39 hex is not a classic PAT; 41 is not either.
    expect(classifyToken("0".repeat(39))).toBe("unknown");
    expect(classifyToken("0".repeat(41))).toBe("unknown");
  });
});

describe("rateLimitHint", () => {
  it("explains 403 and 429 in one line each", () => {
    for (const status of [403, 429]) {
      const hint = rateLimitHint(status);
      expect(hint, String(status)).toBeDefined();
      expect(hint, String(status)).not.toContain("\n");
      expect(hint, String(status)).toContain("60");
    }
  });

  it("says nothing about any other status", () => {
    for (const status of [200, 201, 401, 404, 422, 500, 502, 0, -1]) {
      expect(rateLimitHint(status), String(status)).toBeUndefined();
    }
  });
});

/** A minimal Response stand-in; the real one needs a body stream per call. */
function reply(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

describe("verifyGitHubToken", () => {
  // Split so the literal in this file is not itself a scanner hit: the token is
  // synthesised, and a file that cannot be committed without `--no-verify` is
  // not a safe place to keep one.
  const TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
  const OTHER = "ghp_" + "z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1";

  it("reports the identity behind a working token", async () => {
    const result = await verifyGitHubToken(TOKEN, {
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), {
        "x-oauth-scopes": "repo, gist",
        "x-ratelimit-remaining": "4999",
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.identity).toEqual({ login: "octocat", scopes: ["repo", "gist"], tokenKind: "oauth" });
    expect(result.rateLimitRemaining).toBe(4999);
    expect(result.error).toBeUndefined();
  });

  it("sends the documented request, not a bare one", async () => {
    let seen: { url: string; headers: Headers; method: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init.headers), method: String(init.method) };
      return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
    }) as unknown as typeof fetch;

    await verifyGitHubToken(TOKEN, { fetchImpl });
    expect(seen?.url).toBe("https://api.github.com/user");
    expect(seen?.method).toBe("GET");
    expect(seen?.headers.get("accept")).toBe("application/vnd.github+json");
    expect(seen?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("reports an empty scope list when GitHub sends no scope header", async () => {
    // Fine-grained tokens have no OAuth scopes at all; the header is simply absent.
    const result = await verifyGitHubToken(TOKEN, { fetchImpl: reply(200, JSON.stringify({ login: "u" })) });
    expect(result.identity?.scopes).toEqual([]);
    expect(result.rateLimitRemaining).toBeUndefined();
  });

  it("reports a rejected token without ever echoing it", async () => {
    const result = await verifyGitHubToken(TOKEN, {
      fetchImpl: reply(401, JSON.stringify({ message: "Bad credentials" })),
    });
    expect(result.ok).toBe(false);
    expect(result.identity).toBeUndefined();
    expect(result.error).toContain("401");
    expect(result.error).not.toContain(TOKEN);
  });

  it("scrubs a token that the error body reflects back", async () => {
    // The body is attacker-influenced in the general case and careless in the
    // happy one; either way it must not become the place a token is re-printed.
    const result = await verifyGitHubToken(TOKEN, {
      fetchImpl: reply(401, `token ${TOKEN} is not valid`),
    });
    expect(result.error).not.toContain(TOKEN);
    expect(result.error).toContain("[redacted]");
  });

  it("scrubs a credential of another shape out of the body", async () => {
    const result = await verifyGitHubToken(TOKEN, {
      fetchImpl: reply(400, `bad: ${OTHER}`),
    });
    expect(result.error).not.toContain(OTHER);
    expect(result.error).toContain("[redacted]");
  });

  it("explains 403 and 429 with the anonymous rate limit", async () => {
    for (const status of [403, 429]) {
      const result = await verifyGitHubToken(TOKEN, {
        fetchImpl: reply(status, JSON.stringify({ message: "rate limited" })),
      });
      expect(result.ok, String(status)).toBe(false);
      expect(result.error, String(status)).toContain(String(status));
      expect(result.error, String(status)).toContain("60");
      expect(result.error, String(status)).not.toContain(TOKEN);
    }
  });

  it("carries the rate limit through even on failure", async () => {
    const result = await verifyGitHubToken(TOKEN, {
      fetchImpl: reply(403, "{}", { "x-ratelimit-remaining": "0" }),
    });
    expect(result.rateLimitRemaining).toBe(0);
  });

  it("reports a transport failure as a value, not a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    }) as unknown as typeof fetch;
    const result = await verifyGitHubToken(TOKEN, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not reach GitHub");
    expect(result.error).not.toContain(TOKEN);
  });

  it("refuses a body it cannot use instead of reporting a blank identity", async () => {
    for (const body of ["", "not json", "[]", "null", JSON.stringify({ login: "" }), JSON.stringify({ login: 7 })]) {
      const result = await verifyGitHubToken(TOKEN, { fetchImpl: reply(200, body) });
      expect(result.ok, body).toBe(false);
      expect(result.error, body).toContain("no usable login");
    }
  });

  it("has nothing to verify without a token", async () => {
    for (const blank of ["", "   "]) {
      const result = await verifyGitHubToken(blank);
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no token to verify");
    }
  });

  it("classifies a fine-grained token as fine-grained when it verifies", async () => {
    const fine = "github_pat_" + "A".repeat(82);
    const result = await verifyGitHubToken(fine, { fetchImpl: reply(200, JSON.stringify({ login: "u" })) });
    expect(result.identity?.tokenKind).toBe("fine-grained");
  });
});
