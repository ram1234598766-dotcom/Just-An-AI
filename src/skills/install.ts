import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../config/redact.js";
import { GIT_CONFIG, gitRemoteEnv } from "../tools/gitEnv.js";
import { runProcess } from "../tools/registry.js";
import { fetchUrlText } from "../tools/web.js";
import { jaaPaths } from "../config/paths.js";

const SKILL_FILENAME = "SKILL.md";

/** Result of installing a skill from GitHub. */
export interface InstallResult {
  id: string;
  path: string;
}

const GIT_BIN = "git";
/** A shallow clone of a skill repo. Generous, because it is a network round trip. */
const CLONE_TIMEOUT_MS = 120_000;
/** Matches the `fetch_url` default so a hanging host behaves the same in both. */
const URL_FETCH_TIMEOUT_MS = 15_000;

export interface GitInvocation {
  /** argv for `git`, with the GIT_CONFIG overrides already in place. */
  readonly args: readonly string[];
  /** The COMPLETE environment for the child. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly cwd: string;
}

/**
 * The one place a clone is spawned. Injected so a test can assert on argv and env
 * without a network round trip or a `git` on PATH; production uses
 * {@link defaultGitRunner}, which goes through the hardened `runProcess`.
 */
export type GitRunner = (call: GitInvocation) => Promise<void>;

export interface InstallDeps {
  runGit?: GitRunner;
  /** Injected so `installFromUrl` never touches the network in a test. */
  fetchImpl?: typeof fetch;
}

const defaultGitRunner: GitRunner = async (call) => {
  const result = await runProcess(GIT_BIN, [...call.args], {
    cwd: call.cwd,
    env: { ...call.env },
    timeoutMs: call.timeoutMs,
  });
  if (result.code === 0) return;
  // The message is scrubbed because it is assembled from argv and stderr. argv
  // provably holds no token — that is the whole reason the env form was used —
  // and `redact` is the backstop for anything git itself chooses to print.
  const detail = `${result.stderr}${result.stdout}`.trim();
  throw new Error(`git clone failed (exit ${String(result.code)}): ${redact(detail) || "no output"}`);
};

/**
 * Install a skill from a GitHub `<owner>/<repo>` reference.
 *
 * Uses `git clone --depth 1` into `~/.jaa/skills/<repo>`.  The repo is
 * expected to contain a `SKILL.md` at its root; otherwise it is removed.
 *
 * Authentication is decided by `gitRemoteEnv` in `src/tools/gitEnv.ts`, the one
 * place that answers it: a token, when one is configured and the remote is an
 * https GitHub URL, is a `GIT_CONFIG_VALUE_0` header override and appears in
 * neither the URL, nor argv, nor `.git/config`. A public repo clones with no
 * token and no auth variable set at all. `GIT_TERMINAL_PROMPT=0` goes along
 * either way, so a private repo with no token fails instead of hanging.
 */
export async function installFromGitHub(ownerRepo: string, deps: InstallDeps = {}): Promise<InstallResult> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`expected "<owner>/<repo>", got "${ownerRepo}"`);
  }

  const skillsDir = jaaPaths().skillsDir;
  const targetDir = join(skillsDir, repo);
  if (existsSync(targetDir)) {
    throw new Error(`skill "${repo}" is already installed at ${targetDir}`);
  }

  // One URL, used for both the clone and the auth decision, so the host the
  // token is offered to is by construction the host being contacted.
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;

  mkdirSync(targetDir, { recursive: true });
  const runGit = deps.runGit ?? defaultGitRunner;
  await runGit({
    args: [...GIT_CONFIG, "clone", "--depth", "1", remoteUrl, targetDir],
    env: gitRemoteEnv(remoteUrl),
    timeoutMs: CLONE_TIMEOUT_MS,
    cwd: skillsDir,
  });

  if (!existsSync(join(targetDir, SKILL_FILENAME))) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`no ${SKILL_FILENAME} found at the root of ${owner}/${repo}`);
  }

  return { id: repo, path: targetDir };
}

/** Sanitised skill id derived from a URL's last path segment. */
function skillIdFromUrl(url: string): string {
  let name: string;
  try {
    const parsed = new URL(url);
    const base = parsed.pathname.split("/").pop() ?? "";
    name = base.replace(/\.[^.]+$/, "") || "skill";
  } catch {
    name = "skill";
  }
  // Sanitise: keep alphanumeric, dash, underscore
  name = name.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  return name === "" ? "skill" : name;
}

/**
 * Install a skill from a URL pointing to a raw SKILL.md file.  The skill
 * id is derived from the URL's last path segment (without extension).
 *
 * Three changes from fetching it as a bare `fetch(url, { redirect: "follow" })`:
 *
 *  - **https only.** A `SKILL.md` fetched over cleartext is arbitrary content
 *    installed as instructions, and `jaa skill install` is the one command whose
 *    output is loaded by the agent loop. There is no opt-in for `http:`, because
 *    nothing asks for one; the CLI routes `^https?://` here, so a cleartext
 *    source now fails loudly instead of quietly.
 *  - **A timeout.** An unbounded fetch against a hostile host is a hang.
 *  - **A token only for GitHub.** `isGitHubHost` decides, and redirects are
 *    walked by the same helper `fetch_url` uses, so a `Location` off the
 *    allowlist arrives with no `authorization` header — the same guarantee, from
 *    the same code, instead of a second implementation of it.
 */
export async function installFromUrl(url: string, deps: InstallDeps = {}): Promise<InstallResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing to install a skill over ${parsed.protocol}// - use https:`);
  }

  // Conditional spread under exactOptionalPropertyTypes: an explicit undefined
  // fetchImpl is not the same as an absent key, and "absent" is what selects the
  // global.
  const outcome = await fetchUrlText(url, {
    timeoutMs: URL_FETCH_TIMEOUT_MS,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`failed to fetch ${url}: ${outcome.status} ${outcome.statusText}`);
  }
  const content = outcome.body;

  // Derived from the URL that was ASKED FOR, not the one the body came from: a
  // redirect that renames the file would otherwise change the skill id, which is
  // a behaviour change nobody asked for.
  const name = skillIdFromUrl(url);

  const skillDir = join(jaaPaths().skillsDir, name);
  if (existsSync(skillDir)) {
    throw new Error(`skill "${name}" is already installed at ${skillDir}`);
  }

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, SKILL_FILENAME), content, "utf8");

  return { id: name, path: skillDir };
}

/**
 * Remove an installed skill by id.  Returns `true` if a skill was removed.
 */
export function removeSkill(id: string): boolean {
  const skillDir = join(jaaPaths().skillsDir, id);
  if (!existsSync(skillDir)) return false;
  rmSync(skillDir, { recursive: true, force: true });
  return true;
}

/**
 * List installed skill directories.  Doesn't parse contents — for a full
 * listing use `loadSkills()` from `loader.ts`.
 */
export function listSkillIds(): string[] {
  const skillsDir = jaaPaths().skillsDir;
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
