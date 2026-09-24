import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PkgInfo {
  name: string;
  version: string;
}

const FALLBACK: PkgInfo = { name: "jaa-cli", version: "0.0.0" };
const PACKAGE_NAME_PREFIX = "jaa";
const MAX_WALK_UP = 6;

/**
 * Reads package.json by walking up from this module until a package whose name
 * starts with "jaa" is found. Works from `src/` (tsx dev), from `dist/` (built),
 * and from a global install (`node_modules/jaa-cli/dist/`) — the compiled file's
 * directory depth differs per layout, so a fixed relative path is unsafe.
 */
export function getPkgInfo(): PkgInfo {
  let dir = import.meta.dirname;
  for (let i = 0; i < MAX_WALK_UP; i++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (typeof pkg.name === "string" && pkg.name.startsWith(PACKAGE_NAME_PREFIX)) {
        return {
          name: pkg.name,
          version: typeof pkg.version === "string" ? pkg.version : FALLBACK.version,
        };
      }
    } catch {
      // No package.json at this level (or unreadable) — keep walking up.
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return FALLBACK;
}