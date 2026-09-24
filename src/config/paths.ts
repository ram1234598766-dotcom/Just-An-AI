import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root of all jaa-local state. Overridable for tests and portable setups. */
export function jaaHome(): string {
  return process.env.JAA_HOME ?? join(homedir(), ".jaa");
}

export interface JaaPaths {
  root: string;
  envFile: string;
  configFile: string;
  sessionsDir: string;
  skillsDir: string;
  cacheDir: string;
}

export function jaaPaths(): JaaPaths {
  const root = jaaHome();
  return {
    root,
    envFile: join(root, ".env"),
    configFile: join(root, "config.json"),
    sessionsDir: join(root, "sessions"),
    skillsDir: join(root, "skills"),
    cacheDir: join(root, "cache"),
  };
}

/** Creates the home directory tree if missing. Never creates secret files. */
export function ensureJaaHome(): JaaPaths {
  const paths = jaaPaths();
  for (const dir of [paths.root, paths.sessionsDir, paths.skillsDir, paths.cacheDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return paths;
}