/**
 * Which language server to start for a project, and whether one is installed.
 *
 * The competitive target here is opencode, which ships 30+ auto-installing LSP
 * configurations. Every one of those is a command, a file extension and a set of
 * project markers; this is the same shape, smaller, and it is data rather than
 * code — adding a language is a line in {@link BUILTIN_SERVERS}, not a branch.
 *
 * ## Detection is by project marker, not by "is the command on PATH"
 *
 * A command being installed does not mean a project uses that language. jaa
 * itself has `pyright` on PATH and no Python in it, and starting a Python server
 * for a TypeScript repository costs a process and buys nothing. So a server is
 * only *offered* when the project has a marker for its language, and separately
 * only *started* when its command also resolves. Both conditions are reported,
 * because "no server for this language" and "the server is installed but this
 * project looks like it is not that language" are different facts and the user
 * needs to tell them apart.
 *
 * ## The config shape is opencode's
 *
 * `{ id, command, extensions, markers, install }` is deliberately the same
 * shape opencode uses in its `lsp` config, so a user porting a configuration
 * across does not have to learn a second schema. {@link LspServerConfig.markers}
 * is the one addition: opencode detects purely by extension, which is enough for
 * it and not enough here, because jaa would rather not start a server at all.
 */

import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { findExecutable } from "../utils/spawn.js";

export interface LspServerConfig {
  /** Stable id, used to key the session and to name a tool. */
  id: string;
  /** Executable to run. Resolved on `PATH`; an absolute path also works. */
  command: string;
  /** Arguments. Servers that default to stdio usually need none. */
  args?: string[];
  /** File extensions this server handles, with the dot. */
  extensions: string[];
  /**
   * Files that, if present, mean this project uses the language.
   *
   * A server is offered when the project has one of these **or** a file with a
   * matching extension. An empty list means the extension alone decides, which
   * is the right rule for a language with no config file.
   */
  markers?: string[];
  /** How to install it, for the error message. Never run automatically. */
  install?: string;
  /**
   * A `tsserver` implementation this server should drive, as a path relative to
   * the project root.
   *
   * Only meaningful for servers that are a front-end for something else. It
   * exists because a project can have a perfectly good language server and still
   * have nothing for it to talk to — see the TypeScript 7 note below.
   */
  tsserverPath?: string;
}

/**
 * The built-in set.
 *
 * Deliberately not 30 entries. A configuration that lists a server nobody runs
 * is a configuration nobody maintains, and every entry is a promise that the
 * markers work. These are the ones whose markers are unambiguous.
 */
export const BUILTIN_SERVERS: readonly LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    markers: ["tsconfig.json", "jsconfig.json"],
    install: "npm i -g typescript-language-server typescript",
    /**
     * Phase 17: the `tsserver` to drive.
     *
     * This is not optional decoration. `typescript-language-server` is a
     * front-end for `tsserver`, and **TypeScript 7 ships no `tsserver` at all**
     * — the Go port replaced it. A project on `typescript@7` therefore has
     * nothing for the server to talk to, and it fails at `initialize` with
     * "Could not find a valid TypeScript installation". jaa resolves this
     * separately from the server's command, and reports it as its own fact,
     * because "the language server is not installed" and "the server is
     * installed but this project has no `tsserver`" need different fixes.
     */
    tsserverPath: "typescript5/lib/tsserver.js",
  },
  {
    id: "python",
    command: "pyright-langserver",
    // `pyright` on PATH is the CLI wrapper, not the server. jaa checks both.
    extensions: [".py", ".pyi"],
    markers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
    install: "npm i -g pyright",
  },
  {
    id: "rust",
    command: "rust-analyzer",
    extensions: [".rs"],
    markers: ["Cargo.toml"],
    install: "rustup component add rust-analyzer",
  },
  {
    id: "go",
    command: "gopls",
    extensions: [".go"],
    markers: ["go.mod", "go.work"],
    install: "go install golang.org/x/tools/gopls@latest",
  },
  {
    id: "cpp",
    command: "clangd",
    extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx"],
    markers: ["compile_commands.json", "compile_flags.txt"],
    install: "install clang-tools via your package manager",
  },
  {
    id: "java",
    command: "jdtls",
    extensions: [".java"],
    markers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle"],
    install: "install Eclipse JDT LS and point `command` at its launcher",
  },
];

/** The config for an extension, or `undefined` when jaa has none for it. */
export function serverForExtension(
  extension: string,
  servers: readonly LspServerConfig[] = BUILTIN_SERVERS,
): LspServerConfig | undefined {
  const lower = extension.toLowerCase();
  return servers.find((server) => server.extensions.includes(lower));
}

export interface DetectedServer {
  config: LspServerConfig;
  /** Why jaa thinks this project uses the language. */
  evidence: string;
  /** Whether the command actually resolves on this host. */
  available: boolean;
  /** Set when `available` is false: the command could not be found. */
  reason?: string;
  /**
   * Resolved `tsserver`, for a server that drives one. Undefined when the
   * config has none, and when it names one that is not present — which is a
   * *different* failure from the server being missing, so it is reported as
   * `available: false` with its own reason rather than folded in.
   */
  tsserver?: string;
}

/**
 * Find a project's source files, bounded.
 *
 * The bound is not a performance nicety: a detection walk over a repository
 * containing `node_modules` or a virtualenv visits tens of thousands of files
 * before finding anything, and detection runs on every `jaa ask`.
 */
const IGNORED_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", "coverage", ".cache", ".jaa", ".idea", ".mypy_cache", ".pytest_cache", ".gradle",
]);
const MAX_SCANNED_FILES = 2_000;

/**
 * The server configs this project could use, with availability resolved.
 *
 * Never throws and never starts anything: this is a report, and it is what
 * `jaa doctor` prints.
 */
export function detectServers(
  root: string,
  servers: readonly LspServerConfig[] = BUILTIN_SERVERS,
): DetectedServer[] {
  // Derived from the *caller's* list, not the built-in one. Building it from
  // `BUILTIN_SERVERS` made a caller-supplied server undetectable by extension —
  // its extensions were never collected, so it only ever matched on a marker.
  const extensions = scanExtensions(root, servers);
  const detected: DetectedServer[] = [];

  for (const config of servers) {
    const marker = (config.markers ?? []).find((name) => existsSync(join(root, name)));
    const count = config.extensions.filter((ext) => extensions.has(ext)).length;

    let evidence: string | undefined;
    if (marker !== undefined) evidence = `project marker ${marker}`;
    else if (count > 0) evidence = `${count} ${config.id} file(s) in this project`;
    if (evidence === undefined) continue;

    const resolved = findExecutable(config.command);
    // A server that drives a `tsserver` is only usable when that tsserver is
    // present, so the two are resolved together and reported as one verdict.
    // Checked after the command, because "the server is not installed at all" is
    // the more fundamental problem and the more useful message.
    if (resolved === undefined) {
      detected.push({
        config,
        evidence,
        available: false,
        reason: `"${config.command}" is not on PATH`,
      });
      continue;
    }

    let tsserver: string | undefined;
    if (config.tsserverPath !== undefined) {
      const candidate = resolveTsserver(config.tsserverPath, root);
      if (candidate === undefined) {
        detected.push({
          config,
          evidence,
          available: false,
          reason:
            `${config.command} is installed, but ${config.tsserverPath} is not present in this project, so the ` +
            `server has nothing to drive. TypeScript 7 removed tsserver; install a 5.x alongside it.`,
          ...(tsserver !== undefined ? { tsserver } : {}),
        });
        continue;
      }
      tsserver = candidate;
    }

    detected.push({ config, evidence, available: true, ...(tsserver !== undefined ? { tsserver } : {}) });
  }

  return detected;
}

/**
 * Find a `tsserver` a project can use, preferring one the project installs.
 *
 * Resolution order, and the order matters:
 *
 *   1. the project's own `node_modules` — a project that pins a `tsserver` has
 *      said what it wants, and using a different one would report diagnostics
 *      the project does not agree with;
 *   2. jaa's own `node_modules` — the aliased 5.x copy exists precisely for
 *      this, and is the reason a TypeScript 7 project can still be diagnosed.
 *
 * `require.resolve` is used rather than a hand-built path so Node's own
 * resolution order applies, including `NODE_PATH` and the exports map.
 */
export function resolveTsserver(specifier: string, root: string = process.cwd()): string | undefined {
  // `createRequire`, not a bare `require`: this module is ESM, where `require`
  // is simply not defined. Calling it threw a `ReferenceError` that the catch
  // below swallowed, so every attempt failed and the server was reported as
  // unusable while it was in fact installed. A resolution failure and a
  // resolution *mechanism* failure are now distinguished.
  const requireFromProject = createRequire(join(root, "noop.js"));
  const requireFromJaa = createRequire(import.meta.url);

  const attempts: Array<() => string> = [
    // A project's own pinned copy wins: if it says which tsserver it wants,
    // using a different one would report diagnostics it does not agree with.
    () => requireFromProject.resolve(specifier),
    // Then jaa's own installation, for the aliased 5.x copy that exists
    // precisely so a TypeScript 7 project can still be diagnosed.
    () => requireFromJaa.resolve(specifier),
  ];

  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      // MODULE_NOT_FOUND is the expected "not this one". Anything else is a bug
      // in the resolution mechanism, and hiding it is what made the first
      // version of this function silently return undefined.
      if ((err as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") {
        throw new Error(`could not resolve ${specifier}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return undefined;
}

function scanExtensions(root: string, servers: readonly LspServerConfig[]): Set<string> {
  const wanted = new Set(servers.flatMap((s) => s.extensions));
  const found = new Set<string>();
  const stack: string[] = [root];
  let scanned = 0;

  while (stack.length > 0 && scanned < MAX_SCANNED_FILES) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing detection.
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) stack.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      scanned++;
      const dot = entry.name.lastIndexOf(".");
      if (dot > 0) {
        const ext = entry.name.slice(dot).toLowerCase();
        if (wanted.has(ext)) found.add(ext);
      }
    }
  }
  return found;
}

/** One line per detected server, for `jaa doctor` and `jaa lsp list`. */
export function describeDetection(detected: readonly DetectedServer[]): string[] {
  return detected.map((entry) => {
    if (!entry.available) {
      return `${entry.config.id}: UNAVAILABLE (${entry.reason ?? "unknown"}) — ${entry.evidence}`;
    }
    const tsserver = entry.tsserver !== undefined ? `, driving ${entry.tsserver.split(/[\\/]/).slice(-3).join("/")}` : "";
    return `${entry.config.id}: available (${entry.evidence}${tsserver})`;
  });
}

export { IGNORED_DIRECTORIES, MAX_SCANNED_FILES };
