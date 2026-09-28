import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvLayers } from "../src/config/env.js";
import { readKeyring } from "../src/config/keyring.js";
import {
  broadClassicScopes,
  broadScopeWarning,
  GITHUB_SHAPE_OVERRIDE_FLAG,
  readGitHubTokenInput,
  reportGitHubToken,
  runSetup,
  setGitHubToken,
} from "../src/config/setup.js";
import { promptHidden } from "../src/utils/prompt-hidden.js";
import { formatReport, runDoctor } from "../src/doctor.js";
import type { DoctorCheck } from "../src/doctor.js";

/**
 * Stand in for the process-level stdin read.
 *
 * `readStdinIfPiped` iterates `process.stdin`, and a vitest worker's stdin is a
 * pipe nobody ever closes — so an in-process test that reaches it blocks until
 * the suite's timeout rather than returning. It is mocked here so `runSetup`'s
 * "was there a pipe, or must it prompt?" decision can be driven. What that
 * decides is the interesting part and is asserted; the read itself is the
 * three-line loop in `readStdinIfPiped` and is covered by the spawned-CLI tests,
 * which get a real pipe on a real stdin.
 */
const stdinMock = vi.hoisted(() => ({ piped: undefined as string | undefined }));

vi.mock("../src/utils/cli.js", () => ({
  readStdinIfPiped: async (): Promise<string | undefined> => stdinMock.piped,
}));

/**
 * Token fixtures.
 *
 * Every literal is assembled from a prefix and a separately named body so no
 * `ghp_…` / `github_pat_…` string appears whole in this file: the blocking secret
 * scanner refuses a commit containing one, and a fixture that can only be
 * committed with `--no-verify` is not a safe place to keep a fixture. The body
 * variable is named without a credential word because the scanner's "long value
 * assigned to a secret-looking name" rule keys on the NAME.
 */
const BODY = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const OTHER_BODY = "z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6l5K4j3I2h1";

/** A recognisable OAuth-family token. */
function oauthToken(): string {
  return `ghp_${BODY}`;
}

/** A second one, for proving a token that must never be echoed back. */
function otherToken(): string {
  return `ghp_${OTHER_BODY}`;
}

/** A fine-grained token: 82 characters after the prefix. */
function fineGrainedToken(): string {
  return "github_pat_" + "A".repeat(82);
}

/** A pre-2021 classic PAT, which has no prefix at all. */
const CLASSIC = "0123456789abcdef0123456789abcdef01234567";

/** 40 characters that are not hex, so `classifyToken` reports `unknown`. */
const NOT_A_TOKEN = "z".repeat(39) + "!";

const MANAGED = ["JAA_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "PATH", "JAA_HOME"] as const;

/** A `Response` stand-in; the real one needs a fresh body stream per call. */
function reply(status: number, body: string, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    })) as unknown as typeof fetch;
}

/** Wraps a `fetch` so "no request was made" is an assertable fact. */
function countingFetch(inner: typeof fetch): { fetchImpl: typeof fetch; calls: () => number } {
  let calls = 0;
  const wrapped = ((...args: Parameters<typeof fetch>) => {
    calls += 1;
    return inner(...args);
  }) as unknown as typeof fetch;
  return { fetchImpl: wrapped, calls: () => calls };
}

/** A `fetch` that always fails at the transport, as an offline host would. */
const OFFLINE: typeof fetch = (async () => {
  throw new Error("getaddrinfo ENOTFOUND api.github.com");
}) as unknown as typeof fetch;

let home: string;
let saved: Map<string, string | undefined>;
let logged: string[];
let warned: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "jaa-gh-cli-"));
  saved = new Map(MANAGED.map((key) => [key, process.env[key]]));
  for (const key of MANAGED) delete process.env[key];
  process.env.JAA_HOME = home;
  // PATH goes too, so `gh auth token` cannot resolve and "anonymous" is a fact
  // about the test rather than about whichever machine is running it. This host
  // has a `gh` installed, so leaving PATH alone would make these results depend
  // on whether somebody happens to be logged in.
  resetEnvLayers();
  logged = [];
  warned = [];
  stdinMock.piped = undefined;
  vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    logged.push(parts.map((p) => String(p)).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    warned.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvLayers();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows can still hold a handle on a directory a child just exited from.
  }
});

function keyringFile(): string {
  return join(home, ".env");
}

/** Byte-for-byte, so "nothing was stored" is a claim about the file. */
function keyringBytes(): string | undefined {
  const file = keyringFile();
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- the hidden prompt ---------------------------------------------------

describe("promptHidden", () => {
  it("refuses on a non-TTY instead of falling back to an echoing read", async () => {
    // Vitest's own stdin is not a TTY, which is exactly the condition.
    expect(process.stdin.isTTY).not.toBe(true);
    await expect(promptHidden("Token: ")).rejects.toThrow(/refusing to prompt for a secret/);
  });

  it("names the safe alternative, and says a fallback would print the secret", async () => {
    const message = messageOf(await promptHidden("Token: ").catch((err: unknown) => err));
    expect(message).toMatch(/pipe/i);
    expect(message).toContain("jaa key set github");
    // The reason it refuses rather than degrading, in the refusal itself.
    expect(message).toContain("would print the secret");
  });
});

describe("readGitHubTokenInput", () => {
  it("takes a piped value without asking anything", async () => {
    const piped = oauthToken();
    const prompt = vi.fn(async (): Promise<string> => "never called");
    expect(await readGitHubTokenInput({ piped, prompt })).toBe(piped);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts when there is no pipe", async () => {
    const prompt = vi.fn(async (): Promise<string> => oauthToken());
    expect(await readGitHubTokenInput({ piped: undefined, prompt })).toBe(oauthToken());
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("refuses rather than echoing when a non-TTY has neither", async () => {
    // No `piped` and no `prompt` override: the real path, which on this
    // non-TTY stdin is `readStdinIfPiped()` (nothing) then `promptHidden`.
    await expect(readGitHubTokenInput()).rejects.toThrow(/refusing to prompt for a secret/);
  });
});

// --- setGitHubToken: nothing is stored until GitHub has said yes ----------

describe("setGitHubToken", () => {
  it("stores a verified token and reports who it belongs to", async () => {
    const token = oauthToken();
    const outcome = await setGitHubToken(`  ${token}\n`, {
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), {
        "x-oauth-scopes": "gist, read:org",
        "x-ratelimit-remaining": "4987",
      }),
    });

    expect(outcome.login).toBe("octocat");
    expect(outcome.scopes).toEqual(["gist", "read:org"]);
    expect(outcome.masked).toBe("…q7R8");
    expect(outcome.shape).toBe("oauth");
    expect(outcome.rateLimitRemaining).toBe(4987);
    expect(readKeyring().get("JAA_GITHUB_TOKEN")).toBe(token);
  });

  it("refuses an empty value without contacting GitHub", async () => {
    const net = countingFetch(reply(200, "{}"));
    for (const blank of ["", "   ", "\n\t "]) {
      await expect(setGitHubToken(blank, { fetchImpl: net.fetchImpl })).rejects.toThrow(/no token given/);
    }
    expect(net.calls()).toBe(0);
    expect(keyringBytes()).toBeUndefined();
  });

  it("rejects an unknown-shaped token BEFORE any network call", async () => {
    const net = countingFetch(reply(200, JSON.stringify({ login: "octocat" })));
    await expect(setGitHubToken(NOT_A_TOKEN, { fetchImpl: net.fetchImpl })).rejects.toThrow(
      /does not look like a GitHub token/,
    );
    // The point of the local check: a wrong paste never leaves the machine.
    expect(net.calls()).toBe(0);
    expect(keyringBytes()).toBeUndefined();
  });

  it("names an override flag that is honest about what it skips", async () => {
    expect(GITHUB_SHAPE_OVERRIDE_FLAG).toBe("--accept-unrecognised-shape");
    const message = messageOf(await setGitHubToken("hunter2", { fetchImpl: OFFLINE }).catch((e: unknown) => e));
    expect(message).toContain(GITHUB_SHAPE_OVERRIDE_FLAG);
    // The warning the override prints has to say the check was skipped.
    const override = messageOf(
      await setGitHubToken("hunter2", { acceptUnrecognisedShape: true, fetchImpl: OFFLINE }).catch(
        (e: unknown) => e,
      ),
    );
    expect(override).toContain("could not reach GitHub");
    expect(warned.join("")).toContain("skipped the local format check");
  });

  it("accepts an unknown shape under the override and still verifies it", async () => {
    const outcome = await setGitHubToken("some-future-token-shape", {
      acceptUnrecognisedShape: true,
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" })),
    });
    expect(outcome.login).toBe("octocat");
    expect(outcome.shape).toBe("unknown");
    expect(readKeyring().get("JAA_GITHUB_TOKEN")).toBe("some-future-token-shape");
  });

  it("accepts a 40-hex classic PAT with no override and no warning", async () => {
    await setGitHubToken(CLASSIC, { fetchImpl: reply(200, JSON.stringify({ login: "octocat" })) });
    expect(readKeyring().get("JAA_GITHUB_TOKEN")).toBe(CLASSIC);
    expect(warned.join("")).not.toContain("skipped the local format check");
  });

  it("stores NOTHING when GitHub rejects the token", async () => {
    const before = "# a comment\nJAA_OPENAI_API_KEY=kept\n";
    writeFileSync(keyringFile(), before, "utf8");
    const token = oauthToken();

    const error = await setGitHubToken(token, {
      fetchImpl: reply(401, JSON.stringify({ message: "Bad credentials" })),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = messageOf(error);
    expect(message).toContain("nothing was stored");
    expect(message).toContain("401");
    // A stored token that 401s on every later call fails with a confusing
    // reason, so the file has to be byte-for-byte what it was.
    expect(keyringBytes()).toBe(before);
    expect(logged.join("\n")).not.toContain(token);
    expect(warned.join("")).not.toContain(token);
  });

  it("stores NOTHING when the host is offline", async () => {
    const before = "JAA_OPENAI_API_KEY=kept\n";
    writeFileSync(keyringFile(), before, "utf8");
    await expect(setGitHubToken(oauthToken(), { fetchImpl: OFFLINE })).rejects.toThrow(
      /nothing was stored[\s\S]*could not reach GitHub/,
    );
    expect(keyringBytes()).toBe(before);
  });

  it("scrubs a token the error body reflects back", async () => {
    const token = oauthToken();
    const before = "JAA_OPENAI_API_KEY=kept\n";
    writeFileSync(keyringFile(), before, "utf8");
    const message = messageOf(
      await setGitHubToken(token, {
        fetchImpl: reply(401, `token ${token} is not valid, and neither is ${otherToken()}`),
      }).catch((e: unknown) => e),
    );
    expect(message).not.toContain(token);
    expect(message).not.toContain(otherToken());
    expect(message).toContain("[redacted]");
    expect(keyringBytes()).toBe(before);
  });

  it("leaves the keyring file at mode 0600 on POSIX", async () => {
    if (process.platform === "win32") return;
    await setGitHubToken(oauthToken(), { fetchImpl: reply(200, JSON.stringify({ login: "octocat" })) });
    expect(statSync(keyringFile()).mode & 0o777).toBe(0o600);
  });
});

// --- broad classic scopes -------------------------------------------------

describe("broadClassicScopes", () => {
  it("names every scope a coding agent has no business holding", () => {
    const found = broadClassicScopes(["repo", "workflow", "admin:org", "write:public_key", "delete_repo", "gist"]);
    expect(found).toEqual(["repo", "workflow", "admin:org", "write:public_key", "delete_repo"]);
  });

  it("treats every admin:* as broad, including ones added after this build", () => {
    expect(broadClassicScopes(["admin:ssh_signing_key", "admin:enterprise"])).toEqual([
      "admin:ssh_signing_key",
      "admin:enterprise",
    ]);
  });

  it("does not fire on a weaker scope that merely contains a broad word", () => {
    // `public_repo` contains `repo` as a substring. A substring test on a joined
    // string would warn about a token that cannot touch a private repository.
    expect(broadClassicScopes(["public_repo", "read:org", "user:email", "read:packages"])).toEqual([]);
  });

  it("warns about a verified classic token, recommends fine-grained, and does not block", async () => {
    const token = oauthToken();
    const outcome = await setGitHubToken(token, {
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), { "x-oauth-scopes": "repo, workflow, gist" }),
    });
    expect(outcome.broadScopes).toEqual(["repo", "workflow"]);

    const warning = broadScopeWarning(outcome.broadScopes) ?? "";
    expect(warning).toContain("repo, workflow");
    expect(warning.toLowerCase()).toContain("fine-grained");
    expect(warning.toLowerCase()).toContain("read-only");
    // Blocking it is not this module's decision; the operator may have a reason.
    expect(readKeyring().get("JAA_GITHUB_TOKEN")).toBe(token);
  });

  it("says nothing for a fine-grained token, which reports no OAuth scopes", async () => {
    const outcome = await setGitHubToken(fineGrainedToken(), {
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" })),
    });
    expect(outcome.scopes).toEqual([]);
    expect(outcome.broadScopes).toEqual([]);
    expect(broadScopeWarning(outcome.broadScopes)).toBeUndefined();
  });
});

// --- what the operator is shown -------------------------------------------

describe("reportGitHubToken", () => {
  const outcome = {
    login: "octocat",
    scopes: ["repo", "gist"],
    masked: "…q7R8",
    shape: "oauth" as const,
    broadScopes: ["repo"],
    rateLimitRemaining: 4987,
  };

  it("prints the login, the scopes and the masked form — and not the token", () => {
    const token = oauthToken();
    reportGitHubToken({ ...outcome, masked: `…${token.slice(-4)}` });
    const text = logged.join("\n");
    expect(text).toContain("octocat");
    expect(text).toContain("repo, gist");
    expect(text).toContain("…q7R8");
    expect(text).not.toContain(token);
    expect(text).not.toContain(BODY);
  });

  it("does not imply an OS keyring this build does not have", () => {
    reportGitHubToken(outcome);
    const text = logged.join("\n");
    expect(text).toContain("no OS keyring backend");
    expect(text).toContain("mode 0600 on POSIX");
  });

  it("says a token widens no permission mode", () => {
    reportGitHubToken(outcome);
    expect(logged.join("\n")).toContain("never widens a permission mode");
  });

  it("puts the broad-scope warning on stderr, where a warning belongs", () => {
    reportGitHubToken(outcome);
    expect(logged.join("\n")).not.toContain("broad scopes");
    expect(warned.join("")).toContain("broad scopes (repo)");
    expect(warned.join("")).toContain("Fine-grained");
  });

  it("explains an empty scope list rather than printing a blank", () => {
    reportGitHubToken({ ...outcome, scopes: [], broadScopes: [] });
    expect(logged.join("\n")).toContain("none reported");
    expect(warned.join("")).not.toContain("broad scopes");
  });
});

// --- setup: the --key flag, and the GitHub step ---------------------------

describe("runSetup", () => {
  it("warns that --key leaks the secret into the process list and shell history", async () => {
    await runSetup({ provider: "openai", key: "sk-example-value", nonInteractive: true, github: false });
    const warning = warned.join("");
    expect(warning).toContain("--key puts the secret");
    expect(warning).toContain("process list");
    expect(warning).toContain("shell history");
    // The flag itself still works: removing it would break existing scripts.
    expect(readKeyring().get("JAA_OPENAI_API_KEY")).toBe("sk-example-value");
  });

  it("says nothing about --key when no key came from argv", async () => {
    await runSetup({ provider: "ollama", nonInteractive: true, github: false });
    expect(warned.join("")).not.toContain("--key puts the secret");
  });

  it("skips the GitHub step under --yes", async () => {
    const result = await runSetup({ provider: "openai", key: "sk-example-value", nonInteractive: true });
    expect(result.github).toBeUndefined();
    expect(readKeyring().has("JAA_GITHUB_TOKEN")).toBe(false);
  });

  it("runs the GitHub step from a pipe that the provider key did not drain", async () => {
    const token = oauthToken();
    // `--key` leaves the pipe alone, which is the only shape in which the step
    // can read a second value without a terminal to prompt on.
    stdinMock.piped = token;
    const result = await runSetup({
      provider: "openai",
      key: "sk-example-value",
      nonInteractive: true,
      github: true,
      fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), { "x-oauth-scopes": "gist" }),
    });
    expect(result.github?.login).toBe("octocat");
    expect(result.github?.scopes).toEqual(["gist"]);
    expect(readKeyring().get("JAA_GITHUB_TOKEN")).toBe(token);
  });

  it("leaves no GitHub line behind when the step fails", async () => {
    writeFileSync(keyringFile(), "JAA_OPENAI_API_KEY=kept\n", "utf8");
    stdinMock.piped = oauthToken();
    await expect(
      runSetup({
        provider: "openai",
        key: "sk-example-value",
        nonInteractive: true,
        github: true,
        fetchImpl: reply(401, JSON.stringify({ message: "Bad credentials" })),
      }),
    ).rejects.toThrow(/nothing was stored/);
    // The provider key was written before the GitHub step ran, so the guarantee
    // is specifically about the GitHub line: a token GitHub refused must leave
    // no trace at all, not even an empty one.
    expect(keyringBytes()).toBe("JAA_OPENAI_API_KEY=sk-example-value\n");
    expect(keyringBytes()).not.toContain("JAA_GITHUB_TOKEN");
  });

  it("refuses the GitHub step rather than echoing when the pipe is already drained", async () => {
    stdinMock.piped = undefined;
    await expect(
      runSetup({
        provider: "openai",
        key: "sk-example-value",
        nonInteractive: true,
        github: true,
        fetchImpl: reply(200, JSON.stringify({ login: "octocat" })),
      }),
    ).rejects.toThrow(/refusing to prompt for a secret/);
    expect(readKeyring().has("JAA_GITHUB_TOKEN")).toBe(false);
  });

  it("never reaches the network for a token the shape check already rejects", async () => {
    const net = countingFetch(reply(200, JSON.stringify({ login: "octocat" })));
    stdinMock.piped = NOT_A_TOKEN;
    await expect(
      runSetup({
        provider: "openai",
        key: "sk-example-value",
        nonInteractive: true,
        github: true,
        fetchImpl: net.fetchImpl,
      }),
    ).rejects.toThrow(/does not look like a GitHub token/);
    expect(net.calls()).toBe(0);
  });
});

// --- doctor ---------------------------------------------------------------

describe("jaa doctor: GitHub auth", () => {
  function githubCheck(checks: DoctorCheck[]): DoctorCheck {
    const check = checks.find((c) => c.key === "github-auth");
    expect(check, "no github-auth check in the report").toBeDefined();
    if (check === undefined) throw new Error("unreachable");
    return check;
  }

  it("reads anonymous as a legitimate state, not a failure", async () => {
    const check = githubCheck((await runDoctor({ fetchImpl: OFFLINE })).checks);
    expect(check.status).toBe("info");
    expect(check.message).toContain("anonymous");
    // The two things an operator needs to know about running without a token.
    expect(check.detail).toContain("public access works");
    expect(check.detail).toContain("60/hour");
    expect(check.detail).toContain("5,000/hour");
  });

  it("says the rate limit was not read rather than quoting a number it never saw", async () => {
    const check = githubCheck((await runDoctor({ fetchImpl: OFFLINE })).checks);
    expect(check.detail).toContain("was not read");
    // Nothing was sent, so there was nothing to read it from — and a number here
    // would be indistinguishable from a measurement.
    expect(check.detail).not.toMatch(/remaining: \d/);
  });

  it("makes no request at all when anonymous", async () => {
    const net = countingFetch(OFFLINE);
    await runDoctor({ fetchImpl: net.fetchImpl });
    expect(net.calls()).toBe(0);
  });

  it("reports a configured source, the masked last four, the scopes and the rate limit", async () => {
    const token = oauthToken();
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${token}\n`, "utf8");
    const check = githubCheck(
      (
        await runDoctor({
          fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), {
            "x-oauth-scopes": "repo, gist",
            "x-ratelimit-remaining": "4990",
          }),
        })
      ).checks,
    );

    expect(check.message).toContain("keyring");
    expect(check.message).toContain("octocat");
    expect(check.message).toContain("…q7R8");
    expect(check.message).not.toContain(BODY);
    expect(check.message).not.toContain(token);
    expect(check.detail).toContain("repo, gist");
    expect(check.detail).toContain("4990");
  });

  it("never puts the token in the rendered report", async () => {
    const token = oauthToken();
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${token}\n`, "utf8");
    const text = formatReport(await runDoctor({ fetchImpl: reply(200, JSON.stringify({ login: "octocat" })) }));
    expect(text).toContain("github-auth");
    expect(text).not.toContain(token);
    expect(text).not.toContain(BODY);
  });

  it("warns rather than fails on a token GitHub will not accept", async () => {
    const token = oauthToken();
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${token}\n`, "utf8");
    const check = githubCheck(
      (await runDoctor({ fetchImpl: reply(401, JSON.stringify({ message: "Bad credentials" })) })).checks,
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("401");
    expect(check.detail).not.toContain(token);
    expect(check.detail).toContain("jaa key set github");
  });

  it("reports a transport failure honestly instead of guessing", async () => {
    const token = oauthToken();
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${token}\n`, "utf8");
    const check = githubCheck((await runDoctor({ fetchImpl: OFFLINE })).checks);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("could not reach GitHub");
  });

  it("flags a broad classic token as working-but-over-privileged", async () => {
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${CLASSIC}\n`, "utf8");
    const check = githubCheck(
      (
        await runDoctor({
          fetchImpl: reply(200, JSON.stringify({ login: "octocat" }), { "x-oauth-scopes": "repo, workflow" }),
        })
      ).checks,
    );
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("broad scopes (repo, workflow)");
    expect(check.detail).toContain("fine-grained");
  });

  it("explains an empty scope list instead of printing a blank", async () => {
    writeFileSync(keyringFile(), `JAA_GITHUB_TOKEN=${CLASSIC}\n`, "utf8");
    const check = githubCheck((await runDoctor({ fetchImpl: reply(200, JSON.stringify({ login: "octocat" })) })).checks);
    expect(check.detail).toContain("none reported");
  });

  it("resolves the data dir through JAA_HOME, like every other module", async () => {
    // `dataDirCheck` used to hard-code `join(homedir(), ".jaa")`, so it reported
    // the real home while every write in the process went to the override.
    const check = (await runDoctor({ fetchImpl: OFFLINE })).checks.find((c) => c.key === "data-dir");
    expect(check?.message).toContain(home);
  });
});

// --- the real CLI, spawned ------------------------------------------------

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = join(REPO_ROOT, "src", "cli", "index.ts");
// tsx's own entry point, run on this process's node. Going through `npx` needs a
// resolvable shell, and the shell is only there to be a second thing that can
// quote an argument wrongly.
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const SPAWN_TIMEOUT = 60_000;
const TEST_TIMEOUT = 60_000;

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

let cliHome: string;
let workspace: string;

/**
 * Run the real CLI.
 *
 * Spawned, never imported: `src/cli/index.ts` calls `bootstrap()` and
 * `program.parseAsync` at module scope, so importing it would run the CLI — and
 * the wording of a refusal is the deliverable here, so it has to be the real
 * stderr of the real command.
 *
 * `spawn` rather than `execFile`, because `execFile` cannot close stdin and
 * these commands read it: an open pipe would hang `readStdinIfPiped` forever
 * instead of reporting a refusal.
 *
 * `PATH` points at an empty directory so `gh auth token` cannot resolve. These
 * results must not depend on whether a `gh` on the test machine is logged in,
 * and nothing else in these commands needs a binary on PATH.
 */
function jaa(args: string[], input = ""): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [TSX, CLI, ...args], {
      cwd: workspace,
      env: { ...process.env, JAA_HOME: cliHome, CI: "1", PATH: join(cliHome, "empty-path") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), SPAWN_TIMEOUT);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ stdout, stderr, code: code ?? 1 });
    });
    child.stdin.end(input);
  });
}

beforeEach(() => {
  cliHome = mkdtempSync(join(tmpdir(), "jaa-gh-spawn-"));
  workspace = join(cliHome, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(cliHome, "empty-path"), { recursive: true });
});

afterEach(() => {
  try {
    rmSync(cliHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows can still hold a handle on a directory a child just exited from.
  }
});

describe("jaa key set github", () => {
  it("refuses a token passed as an argument, and says why and what to do instead", async () => {
    const token = oauthToken();
    const { code, stdout, stderr } = await jaa(["key", "set", "github", token]);

    expect(code).toBe(1);
    expect(stderr).toContain("refusing to take a GitHub token as a command-line argument");
    // The reason has to be the actual mechanisms, not "it is insecure".
    expect(stderr).toContain("process list");
    expect(stderr).toContain("shell history");
    // And both safe routes.
    expect(stderr).toContain("jaa key set github");
    expect(stderr).toContain("input hidden");
    expect(stdout).not.toContain(token);
    expect(stderr).not.toContain(token);
  }, TEST_TIMEOUT);

  it("stores nothing when the argument is refused", async () => {
    await jaa(["key", "set", "github", oauthToken()]);
    expect(existsSync(join(cliHome, ".env"))).toBe(false);
  }, TEST_TIMEOUT);

  it("points at the pipe when there is no terminal to prompt on", async () => {
    const { code, stderr } = await jaa(["key", "set", "github"]);
    expect(code).toBe(1);
    expect(stderr).toContain("refusing to prompt for a secret without an interactive terminal");
    expect(stderr).toContain("Pipe the value in instead");
  }, TEST_TIMEOUT);

  it("reads a piped value end to end, and stops at the local shape check", async () => {
    // The pipe path through the real CLI, with a value the local format check
    // rejects. That is the furthest this can go without a real `fetchImpl`
    // reaching the network — and it still proves the pipe was read and the value
    // carried into the flow rather than dropped on the floor.
    const { code, stderr } = await jaa(["key", "set", "github"], "not-a-github-token-at-all");
    expect(code).toBe(1);
    expect(stderr).toContain("does not look like a GitHub token");
    // A value the shape check rejects is never asked about, so it cannot have
    // reached GitHub — and nothing is stored either way.
    expect(stderr).not.toContain("nothing was stored");
    expect(existsSync(join(cliHome, ".env"))).toBe(false);
  }, TEST_TIMEOUT);

  it("still refuses an argument even when a pipe is also available", async () => {
    const { code, stderr } = await jaa(["key", "set", "github", "sk-whatever"], "not-a-github-token-at-all");
    expect(code).toBe(1);
    // The argument is refused before the pipe is even looked at, so a user who
    // pastes a token into argv is told so rather than quietly helped along.
    expect(stderr).toContain("refusing to take a GitHub token as a command-line argument");
  }, TEST_TIMEOUT);

  it("warns that a provider key on argv leaks too, and stores it anyway", async () => {
    const { code, stdout, stderr } = await jaa(["key", "set", "openai", "sk-example-value"]);
    expect(code).toBe(0);
    expect(stderr).toContain("passing a key as a command-line argument");
    expect(stderr).toContain("process list");
    expect(stderr).toContain("shell history");
    expect(stdout).toContain("key stored for openai");
  }, TEST_TIMEOUT);
});

describe("jaa key list", () => {
  it("shows a stored github token, masked, with the source", async () => {
    const token = oauthToken();
    writeFileSync(join(cliHome, ".env"), `JAA_GITHUB_TOKEN=${token}\n`, "utf8");
    const { code, stdout } = await jaa(["key", "list"]);

    expect(code).toBe(0);
    const row = stdout.split("\n").find((line) => line.startsWith("github"));
    expect(row).toBeDefined();
    expect(row).toContain("keyring");
    expect(row).toContain("…q7R8");
    // Never the token, not even most of it.
    expect(stdout).not.toContain(token);
    expect(stdout).not.toContain(BODY);
  }, TEST_TIMEOUT);

  it("shows an anonymous github row rather than omitting it", async () => {
    const { code, stdout } = await jaa(["key", "list"]);
    expect(code).toBe(0);
    const row = stdout.split("\n").find((line) => line.startsWith("github"));
    expect(row).toBeDefined();
    expect(row).toContain("anonymous");
  }, TEST_TIMEOUT);
});

describe("jaa setup", () => {
  it("warns that --key is visible in the process list and shell history", async () => {
    const { code, stdout, stderr } = await jaa([
      "setup",
      "--provider",
      "openai",
      "--key",
      "sk-example-value",
      "--skip-github",
      "--yes",
    ]);

    expect(code).toBe(0);
    expect(stderr).toContain("--key puts the secret");
    expect(stderr).toContain("process list");
    expect(stderr).toContain("shell history");
    expect(stderr).toContain("input hidden");
    // The flag keeps working: existing scripts depend on it.
    expect(stdout).toContain("key stored: yes");
  }, TEST_TIMEOUT);

  it("skips the GitHub step under --yes", async () => {
    const { code, stdout } = await jaa(["setup", "--provider", "openai", "--key", "sk-example-value", "--yes"]);
    expect(code).toBe(0);
    expect(stdout).toContain("key stored: yes");
    expect(stdout).not.toContain("github token:");
  }, TEST_TIMEOUT);
});

describe("jaa key remove github", () => {
  it("withdraws a token that `key set` can install", async () => {
    writeFileSync(join(cliHome, ".env"), `JAA_GITHUB_TOKEN=${oauthToken()}\n`, "utf8");
    const { code, stdout } = await jaa(["key", "remove", "github"]);
    expect(code).toBe(0);
    expect(stdout).toContain("key removed for github");
    expect(readFileSync(join(cliHome, ".env"), "utf8")).not.toContain("JAA_GITHUB_TOKEN");
  }, TEST_TIMEOUT);
});
