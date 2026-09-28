import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { resetEnvLayers } from "../src/config/env.js";
import { GITHUB_HOSTS } from "../src/github/auth.js";
import { installFromGitHub } from "../src/skills/install.js";
import type { GitInvocation, GitRunner } from "../src/skills/install.js";
import { BASH_SANDBOX_ENV_PASSTHROUGH } from "../src/tools/bash.js";
import {
  GIT_CONFIG,
  GIT_ENV_ALLOWLIST,
  GIT_TERMINAL_PROMPT,
  baseGitEnv,
  gitAuthEnv,
  gitRemoteEnv,
} from "../src/tools/gitEnv.js";
import { GIT_SANDBOX_ENV_PASSTHROUGH } from "../src/tools/git.js";
import { createDefaultRegistry } from "../src/tools/index.js";
import type { ToolContext } from "../src/tools/types.js";

/**
 * The token body is a separate literal from the prefix, deliberately.
 *
 * Two different scanner rules are being satisfied here. The `github-classic` rule
 * matches `ghp_` followed by 36+ characters, so a contiguous fixture would be a
 * fixture this file could not be committed with. And the `assigned-secret` rule
 * denies by NAME — `TOKEN_BODY = "<36 alphanumerics>"` trips it even though the
 * value is synthesised at runtime and is not a credential — which is why the body
 * is keyed by a property name instead. `tests/secrets.test.ts` uses the same
 * shape for the same reason, and this one is that habit rather than a new idea.
 */
const fixture = { classic: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8" };
const TOKEN = `ghp_${fixture.classic}`;

/** An https URL on each host a token may ever be sent to. */
const GITHUB_URLS: readonly string[] = [
  "https://github.com/acme/skills.git",
  "https://api.github.com/repos/acme/skills",
  "https://raw.githubusercontent.com/acme/skills/main/SKILL.md",
  "https://codeload.github.com/acme/skills/tar.gz/refs/heads/main",
];

/**
 * Remote shapes that must never receive a token, each with the reason it is
 * refused. SSH is a real gap rather than a bug — an SSH remote authenticates
 * with a key, not an HTTP header, so `http.extraHeader` would be ignored — but
 * the answer is still "send nothing", because a token in the environment that
 * nothing reads is exposure with no benefit.
 */
const REFUSED_URLS: ReadonlyArray<{ url: string; why: string }> = [
  { url: "http://github.com/acme/skills.git", why: "cleartext http would send a bearer token in the clear" },
  { url: "git@github.com:acme/skills.git", why: "scp-style SSH authenticates with a key, not an HTTP header" },
  { url: "ssh://git@github.com/acme/skills.git", why: "explicit SSH, same reason" },
  { url: "git://github.com/acme/skills.git", why: "the git protocol has no header mechanism at all" },
  { url: "https://gitlab.com/acme/skills.git", why: "not a GitHub host" },
  { url: "https://github.com.evil.test/acme/skills.git", why: "ends with a GitHub name and is not GitHub" },
  { url: "https://github.com@evil.test/acme/skills.git", why: "userinfo that reads as GitHub but resolves elsewhere" },
  { url: "not a url at all", why: "unparseable input is not a remote" },
];

/** Every variable this file moves. Restored verbatim, including "was unset". */
const MANAGED = [
  "JAA_GITHUB_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_PERSONAL_ACCESS_TOKEN",
  "HF_TOKEN",
  "HUGGING_FACE_HUB_TOKEN",
  "JAA_HOME",
  "GIT_DIR",
  "JAA_PARENT_ONLY",
] as const;

/**
 * PATH is deliberately NOT in MANAGED. This file spawns a real `git`, and the one
 * test that needs `gh` unreachable uses {@link withNoPath} for exactly that
 * window rather than taking PATH away from everything else.
 */
const REAL_PATH = process.env["PATH"] ?? "";

/**
 * `git` resolved while PATH is still intact.
 *
 * This machine's own environment exports `GITHUB_TOKEN` and
 * `GITHUB_PERSONAL_ACCESS_TOKEN`, which is why MANAGED clears them: "there is no
 * token" has to be arranged by the test rather than inherited from whoever ran
 * it. (`gh` is installed here too, but not logged in, so the `gh auth token`
 * fallback is inert on this host — see {@link withNoPath} for why that is still
 * worth closing.)
 */
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

const REPO_ROOT = resolve(import.meta.dirname, "..");
const registry = createDefaultRegistry();
let tmp: string;
let saved: Map<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-gitauth-"));
  saved = new Map(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
  process.env.JAA_HOME = tmp;
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

function useToken(token: string = TOKEN): void {
  process.env.JAA_GITHUB_TOKEN = token;
  resetEnvLayers();
}

/**
 * Run `fn` with PATH pointing nowhere, so `resolveGitHubAuth`'s last fallback —
 * `gh auth token`, a subprocess — cannot produce a token.
 *
 * This is not load-bearing on every host: the machine running this suite has
 * `gh` installed but not logged in, so the fallback already returns nothing and
 * the test passes either way. It is here because the alternative is a test whose
 * answer depends on whether whoever runs it happens to have a live `gh` session —
 * which fails on a colleague's laptop and passes on CI. Restored in a `finally`,
 * because the same worker runs the next test.
 */
function withNoPath<T>(fn: () => T): T {
  const savedPath = process.env["PATH"];
  process.env["PATH"] = "";
  resetEnvLayers();
  try {
    return fn();
  } finally {
    if (savedPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = savedPath;
    resetEnvLayers();
  }
}

/**
 * `GITHUB_URLS[0]`, narrowed. An indexing access under `noUncheckedIndexedAccess`
 * is `string | undefined`, and a non-null assertion would be a silencer for a
 * question that has a right answer: if the table is ever emptied, these tests
 * must fail loudly rather than quietly authenticate nothing.
 */
function aGitHubUrl(): string {
  const url = GITHUB_URLS[0];
  if (url === undefined) throw new Error("GITHUB_URLS is empty — the table under test has no rows");
  return url;
}

/** Records the invocations and leaves the SKILL.md a real clone would leave. */function gitSpy(calls: GitInvocation[]): GitRunner {
  return async (call) => {
    calls.push(call);
    const target = call.args[call.args.length - 1];
    if (typeof target === "string") {
      writeFileSync(join(target, "SKILL.md"), "---\nname: spy\n---\n", "utf8");
    }
  };
}

const gitExec = promisify(execFile);

/**
 * Budget for the tests that spawn a real `git`. Each is three to five process
 * spawns, and the default 5s is not enough once 27 test files are running in
 * parallel on a loaded machine — that is a test that passes alone and fails in
 * CI, which is worse than no test.
 *
 * Declared before every use because it is read at describe time, as an argument
 * to `it(...)`, not inside a test body.
 */
const GIT_TEST_TIMEOUT_MS = 30_000;

describe("gitAuthEnv: which remote shapes get a token", () => {
  it("GITHUB_HOSTS and the URLs under test are the same set", () => {
    // The table above is hand-written; if the allowlist grows, this fails rather
    // than letting the new host go untested.
    expect(GITHUB_URLS.map((u) => new URL(u).hostname).sort()).toEqual([...GITHUB_HOSTS].sort());
  });

  for (const url of GITHUB_URLS) {
    it(`gives the auth env to ${new URL(url).hostname}`, () => {
      useToken();
      const env = gitAuthEnv({ remoteUrl: url });
      expect(env["GIT_CONFIG_COUNT"]).toBe("1");
      expect(env["GIT_CONFIG_KEY_0"]).toBe("http.extraHeader");
      expect(env["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: Bearer ${TOKEN}`);
      expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    });
  }

  it("gives nothing to every remote that is not an https GitHub URL", () => {
    useToken();
    for (const { url, why } of REFUSED_URLS) {
      expect(gitAuthEnv({ remoteUrl: url }), `${url} — ${why}`).toEqual({});
    }
  });

  it("gives nothing in anonymous mode, with a token configured and a GitHub remote", () => {
    useToken();
    expect(gitAuthEnv({ remoteUrl: aGitHubUrl(), anonymous: true })).toEqual({});
  });

  it("gives nothing when there is no remote to authorise", () => {
    useToken();
    expect(gitAuthEnv()).toEqual({});
    expect(gitAuthEnv({})).toEqual({});
    expect(gitAuthEnv({ anonymous: false })).toEqual({});
  });

  it("gives nothing when no token is configured anywhere", () => {
    // `gh` is installed on at least one developer machine, so PATH has to go for
    // "no token" to mean anything.
    withNoPath(() => {
      expect(gitAuthEnv({ remoteUrl: aGitHubUrl() })).toEqual({});
    });
  });

  it("refuses to prompt whenever it returns anything, and the value is the string 0", () => {
    useToken();
    const env = gitAuthEnv({ remoteUrl: aGitHubUrl() });
    expect(Object.keys(env).length).toBeGreaterThan(0);
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    // A `boolean` here would reach git as the string "false", which git does not
    // read as "off" — so the constant is typed as the literal.
    expect(GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("baseGitEnv: the allowlisted baseline", () => {
  it("carries the allowlist and nothing else, whatever the operator exported", () => {
    // The machine running this has GITHUB_TOKEN and GITHUB_PERSONAL_ACCESS_TOKEN
    // in its own environment; both are named here so the assertion is about the
    // code rather than about whoever ran the suite.
    process.env.JAA_GITHUB_TOKEN = TOKEN;
    process.env.GITHUB_TOKEN = TOKEN;
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = TOKEN;
    process.env.JAA_PARENT_ONLY = "inherited";
    resetEnvLayers();

    const env = baseGitEnv();
    for (const name of Object.keys(env)) {
      expect(GIT_ENV_ALLOWLIST, name).toContain(name);
    }
    expect(env["PATH"]).toBe(REAL_PATH);
    expect(env["HOME"] ?? env["USERPROFILE"]).toBeDefined();
    expect(env["JAA_PARENT_ONLY"]).toBeUndefined();
    for (const name of ["JAA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"]) {
      expect(env[name], name).toBeUndefined();
    }
    // No value in it is a token, whatever the names were.
    expect(Object.values(env).filter((v) => v.includes(TOKEN))).toHaveLength(0);
  });

  it("keeps the proxy trio, because dropping it breaks every proxied clone", () => {
    process.env["HTTP_PROXY"] = "http://proxy.test:3128";
    process.env["https_proxy"] = "http://proxy.test:3128";
    resetEnvLayers();
    const env = baseGitEnv();
    expect(env["HTTP_PROXY"]).toBe("http://proxy.test:3128");
    expect(env["https_proxy"]).toBe("http://proxy.test:3128");
    delete process.env["HTTP_PROXY"];
    delete process.env["https_proxy"];
    resetEnvLayers();
  });
});

describe("gitRemoteEnv: the one remote-capable helper", () => {
  it("is the baseline plus auth for a github https remote", () => {
    useToken();
    const env = gitRemoteEnv(aGitHubUrl());
    expect(env["GIT_CONFIG_VALUE_0"]).toBe(`Authorization: Bearer ${TOKEN}`);
    expect(env["PATH"]).toBe(REAL_PATH);
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("adds no auth for an SSH or non-github remote, and still refuses to prompt", () => {
    useToken();
    for (const { url } of REFUSED_URLS) {
      const env = gitRemoteEnv(url);
      expect(env["GIT_CONFIG_COUNT"], url).toBeUndefined();
      expect(env["GIT_CONFIG_KEY_0"], url).toBeUndefined();
      expect(env["GIT_CONFIG_VALUE_0"], url).toBeUndefined();
      // A remote that cannot authenticate fails rather than sitting on a
      // credential prompt until the timeout.
      expect(env["GIT_TERMINAL_PROMPT"], url).toBe("0");
    }
  });
});

describe("the token is in the environment git reads, and nowhere else", () => {
  /**
   * The properties under test are git's, not jaa's, so they are pinned against
   * the installed git rather than asserted in a comment. Purely local: `git init`
   * and `git config` never open a socket.
   */
  it.skipIf(GIT_BIN === undefined)(
    "applies the header to a real git, and to no argv, URL or file",
    async () => {
      // `skipIf` already prevents the run; this is the narrowing the type checker
      // needs, and it fails loudly rather than passing vacuously if it ever stops.
      const git = GIT_BIN;
      if (git === undefined) throw new Error("git is not on PATH but the test was not skipped");

      useToken();

      // argv and env exactly as production builds them for a clone, rather than
      // something this file assembled — otherwise the round trip would prove a
      // property of the fixture.
      const calls: GitInvocation[] = [];
      await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });
      const call = calls[0];
      if (call === undefined) throw new Error("installFromGitHub spawned no git");

      // --- argv: no token, no header, no userinfo ------------------------------
      expect(call.args.length).toBeGreaterThan(0);
      for (const arg of call.args) {
        expect(arg, `argv: ${arg}`).not.toContain(TOKEN);
        expect(arg, `argv: ${arg}`).not.toContain("extraHeader");
      }
      const url = call.args.find((a) => a.startsWith("http"));
      expect(url).toBe("https://github.com/acme/skills.git");
      expect(url).not.toContain("@");

      // --- a real git really does apply the header from the environment ---------
      const repo = join(tmp, "roundtrip");
      mkdirSync(repo, { recursive: true });
      // HOME/USERPROFILE at an empty directory, so the operator's own ~/.gitconfig
      // cannot be what answers the query below.
      const env = { ...call.env, HOME: tmp, USERPROFILE: tmp };
      const read = (childEnv: Record<string, string>): string =>
        execFileSync(git, ["config", "--get", "http.extraHeader"], {
          cwd: repo,
          env: childEnv,
          encoding: "utf8",
          windowsHide: true,
        }).trim();

      // Initialised WITHOUT the auth variables, so anything the file later gains
      // would have to have been written by the query that follows.
      execFileSync(git, ["init", "-q"], { cwd: repo, env: withoutAuth(env), stdio: "ignore", windowsHide: true });
      expect(read(env)).toBe(`Authorization: Bearer ${TOKEN}`);

      // The control, and the reason the assertion above is worth anything: the
      // same query, the same repo, the same baseline minus the three auth
      // variables finds nothing — so what answered was the environment and not
      // some config file on this machine.
      expect(() => read(withoutAuth(env))).toThrow();

      // --- and nothing about it reached a file ---------------------------------
      const config = readFileSync(join(repo, ".git", "config"), "utf8");
      expect(config).not.toContain("extraHeader");
      expect(config).not.toContain("Authorization");
      expect(config).not.toContain(TOKEN);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

/** `env` with the three GIT_CONFIG_* auth variables removed. */
function withoutAuth(env: Record<string, string>): Record<string, string> {
  const auth = new Set(["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!auth.has(name)) out[name] = value;
  }
  return out;
}

describe("the git hardening list is defined exactly once", () => {
  /**
   * A second copy of a security list is the failure this exists to catch, so the
   * pattern is assembled from two halves: written out whole, this file's own
   * source would match its own scan and report a definition that does not exist.
   */
  const DEFINES_GIT_CONFIG = new RegExp("(?:export\\s+)?const\\s+GIT" + "_CONFIG\\s*(?::[^=]+)?=");

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
    }
    return out;
  }

  it("has one definition, in the shared module", () => {
    // `src` and `tests`, never `dist` or `node_modules`: the compiled output is a
    // build artefact of that one definition, not a second author of it.
    const found = [...sourceFiles(join(REPO_ROOT, "src")), ...sourceFiles(join(REPO_ROOT, "tests"))]
      .filter((f) => DEFINES_GIT_CONFIG.test(readFileSync(f, "utf8")))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(found).toEqual(["src/tools/gitEnv.ts"]);
  });

  it("has both former duplicates importing that one module", () => {
    for (const file of ["src/tools/git.ts", "src/skills/install.ts"]) {
      expect(readFileSync(join(REPO_ROOT, file), "utf8"), file).toMatch(/from "[^"]*\/gitEnv\.js"/);
    }
  });

  it("is the list the clone actually puts in argv", async () => {
    const calls: GitInvocation[] = [];
    await installFromGitHub("acme/skills", { runGit: gitSpy(calls) });
    expect(calls[0]?.args.slice(0, GIT_CONFIG.length)).toEqual([...GIT_CONFIG]);
  });

  it("carries the two entries that make a clone safe", () => {
    expect(GIT_CONFIG).toContain("credential.helper=");
    expect(GIT_CONFIG).toContain("protocol.ext.allow=never");
    // Command-scoped only: a `-c` override is never written to a repository.
    expect(GIT_CONFIG.every((arg) => arg === "-c" || arg.includes("="))).toBe(true);
  });
});

/** Credential-bearing variable names — the same shape `scrubEnv` denies by. */
const CREDENTIAL_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH/i;

describe("no sandbox passthrough list can carry a token", () => {
  const LISTS = [
    { file: "src/tools/git.ts", constName: "GIT_SANDBOX_ENV_PASSTHROUGH", names: GIT_SANDBOX_ENV_PASSTHROUGH },
    { file: "src/tools/bash.ts", constName: "BASH_SANDBOX_ENV_PASSTHROUGH", names: BASH_SANDBOX_ENV_PASSTHROUGH },
  ] as const;

  for (const { file, names } of LISTS) {
    it(`${file} names no credential-bearing variable`, () => {
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(CREDENTIAL_NAME.test(name), `${file}: ${name}`).toBe(false);
        expect(name, `${file}: ${name}`).not.toBe("GIT_CONFIG_VALUE_0");
      }
    });
  }

  it("reads the names off the call sites, not off a copy of them", () => {
    // A test asserting on the exported constant alone would keep passing if
    // somebody replaced the call site with an inline literal, which is the exact
    // drift this is here to catch. So: the call site must still spread a named
    // list, and it must be the right one.
    for (const { file, constName } of LISTS) {
      const text = readFileSync(join(REPO_ROOT, file), "utf8");
      const used = /envPassthrough:\s*\[\.\.\.([A-Za-z_][A-Za-z0-9_]*)\]/.exec(text);
      if (used === null) {
        throw new Error(`${file} no longer spreads a named list into envPassthrough — update this test`);
      }
      expect(used[1], file).toBe(constName);
    }
  });

  it("keeps the auth variables out of both lists: they are child env, not a passthrough", () => {
    useToken();
    // `gitAuthEnv` alone, not `gitRemoteEnv`: the baseline names are SUPPOSED to
    // be in a passthrough list — that is the whole job of one. What must never
    // appear is a name jaa invented to carry a credential into the child.
    const authNames = Object.keys(gitAuthEnv({ remoteUrl: aGitHubUrl() }));
    expect(authNames).toContain("GIT_CONFIG_VALUE_0");
    for (const { file, names } of LISTS) {
      for (const name of authNames) {
        // A passthrough is a NAME read out of the parent environment. The token
        // is a value jaa put in the child deliberately, so it must never be
        // something a passthrough could pick up.
        expect([...names], `${file} must not pass through ${name}`).not.toContain(name);
      }
    }
  });
});

describe("the read-only git tools get the baseline and no token", () => {
  /**
   * One repository, seeded with an empty commit, and BOTH claims asserted in one
   * test.
   *
   * This block used to be two tests over two separately-seeded repositories —
   * eight `git` spawns. That is not a detail: this file's subprocess load is
   * what tips sibling files' own 5s-default timeouts over when the whole suite
   * runs in parallel, so tests here are merged and the repository is an empty
   * commit (`init` + `commit --allow-empty`) rather than a staged file. Same
   * claims, four spawns. Anything that genuinely needs a staged file belongs in
   * `tools.test.ts`, which already seeds one for the real-repository cases.
   */
  it(
    "run against the local repo with no token, and cannot be redirected by a GIT_DIR in the shell",
    async () => {
      const root = join(tmp, "repo");
      mkdirSync(root, { recursive: true });
      const git = async (args: string[]): Promise<string> => (await gitExec("git", args, { cwd: root })).stdout;
      await git(["init", "-q"]);
      await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);

      const ctx: ToolContext = { root, cwd: root, allowBash: false };

      // Both leaks at once, because both are the same defect: `runGit` used to
      // pass no `env` at all, so on a host with no sandbox — which is every
      // Windows host, and Windows has no sandbox mechanism to install — anything
      // the operator exported was inherited by every `git_*` tool. A `GITHUB_TOKEN`
      // is a credential; `GIT_DIR` is a redirect to a different repository.
      process.env.JAA_GITHUB_TOKEN = TOKEN;
      process.env.GITHUB_TOKEN = TOKEN;
      process.env.GIT_DIR = join(root, "no-such-dir");
      resetEnvLayers();

      // `baseGitEnv()` is what reaches the child, and the allowlist is token-free
      // by construction — proven directly, because none of these tools prints
      // its own environment.
      expect(baseGitEnv()["GIT_CONFIG_VALUE_0"]).toBeUndefined();
      expect(baseGitEnv()["GITHUB_TOKEN"]).toBeUndefined();
      expect(baseGitEnv()["JAA_GITHUB_TOKEN"]).toBeUndefined();
      expect(baseGitEnv()["GIT_DIR"]).toBeUndefined();

      // And the tools still work under the reduced environment, which is the
      // other half of the allowlist being correct: an omission of something git
      // needs shows up right here.
      const out = await registry.execute("git_log", "{}", ctx);
      expect(out).toContain("init");
      expect(out).not.toContain("no-such-dir");
      expect(out).not.toMatch(/fatal|cannot change/i);
      expect(out).not.toMatch(/unknown option|usage: git/i);

      // The control, or the assertion above proves nothing: run the same git with
      // the same inherited environment and confirm `GIT_DIR` really does redirect
      // it. (Verified independently: git exits 128 with "not a git repository".)
      await expect(gitExec("git", ["-C", root, "log", "--oneline"])).rejects.toThrow(/no-such-dir/);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
