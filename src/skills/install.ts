import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { jaaPaths } from "../config/paths.js";

const execFileAsync = promisify(execFile);

const SKILL_FILENAME = "SKILL.md";

/** Result of installing a skill from GitHub. */
export interface InstallResult {
  id: string;
  path: string;
}

/**
 * Install a skill from a GitHub `<owner>/<repo>` reference.
 *
 * Uses `git clone --depth 1` into `~/.jaa/skills/<repo>`.  The repo is
 * expected to contain a `SKILL.md` at its root; otherwise it is removed.
 */
export async function installFromGitHub(ownerRepo: string): Promise<InstallResult> {
  const [owner, repo] = ownerRepo.split("/");
  if (!owner || !repo) {
    throw new Error(`expected "<owner>/<repo>", got "${ownerRepo}"`);
  }

  const skillsDir = jaaPaths().skillsDir;
  const targetDir = join(skillsDir, repo);
  if (existsSync(targetDir)) {
    throw new Error(`skill "${repo}" is already installed at ${targetDir}`);
  }

  mkdirSync(targetDir, { recursive: true });
  await execFileAsync("git", [
    "clone",
    "--depth",
    "1",
    `https://github.com/${owner}/${repo}.git`,
    targetDir,
  ]);

  if (!existsSync(join(targetDir, SKILL_FILENAME))) {
    rmSync(targetDir, { recursive: true, force: true });
    throw new Error(`no ${SKILL_FILENAME} found at the root of ${owner}/${repo}`);
  }

  return { id: repo, path: targetDir };
}

/**
 * Install a skill from a URL pointing to a raw SKILL.md file.  The skill
 * id is derived from the URL's last path segment (without extension).
 */
export async function installFromUrl(url: string): Promise<InstallResult> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const content = await res.text();

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
  if (!name) name = "skill";

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
