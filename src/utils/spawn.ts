/**
 * Platform-safe resolution of a command name into something `spawn` accepts.
 *
 * ## The problem this exists to solve
 *
 * On Windows, `spawn("typescript-language-server")` fails with `ENOENT` and
 * `spawn("typescript-language-server.cmd")` fails with `EINVAL`, because npm
 * installs a *shim* rather than a binary and Node refuses to spawn batch files
 * without a shell. Without this file no language server can be started on
 * Windows at all, so Phase 17 does not work there without it.
 *
 * ## Why this does NOT route through `cmd.exe`
 *
 * The obvious fix is `cmd.exe /d /s /c`, which is what the `bash` tool does. It
 * was measured, and it is wrong for this job. A language server is spawned with
 * a project path, and passing arguments through `cmd /c` does not reliably
 * protect them. Measured on this host, with each argument double-quoted:
 *
 * | argument contains | result                                            |
 * |-------------------|---------------------------------------------------|
 * | a space           | works, provided no `/s` flag is also passed         |
 * | `&` or `\|`       | **breaks out** — the tail runs as a second command   |
 * | `>`               | **breaks out** — redirect, "directory name invalid"  |
 * | `%`               | **expands** — `%PATH%` was replaced with the real one |
 * | `/s` flag at all  | breaks every quoted form, including the safe ones   |
 *
 * A project directory a user typed can contain any of those. Routing it through
 * a shell would mean jaa executes a command the operator's path chose — in a
 * codebase whose entire permission story is "do not run a shell where an argv
 * suffices". So this file never builds a shell line.
 *
 * ## What it does instead
 *
 * Windows runs npm shims as `node "<script>" <args>`; that is what the `.cmd`
 * contains. So on Windows this file locates the shim, reads the standard npm
 * format out of it, and spawns `process.execPath` with the script path. Every
 * argument then stays an argv element: a space, an `&`, a `%` or a `>` in a
 * project path is data, and cmd never sees it.
 *
 * If the shim is not in the format this recognises, {@link resolveSpawn} refuses
 * with a message naming the file. It does not guess, and it does not fall back to
 * a shell.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface SpawnPlan {
  /** What to pass as the first argument to `spawn`. */
  command: string;
  /** The remaining arguments, as a real argv vector. */
  args: string[];
  /**
   * True when the plan is `process.execPath` plus a script extracted from an npm
   * shim. Recorded so a caller — and a test — can see that a shim was unwrapped
   * rather than executed, rather than having to infer it.
   */
  viaShim: boolean;
  /** The shim that was unwrapped, when one was. */
  shim?: string;
}

/** Extensions Windows will actually execute, in the order it searches them. */
const WINDOWS_EXECUTABLE_EXTENSIONS = [".com", ".exe", ".bat", ".cmd"];

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Find a command on `PATH`, the way Windows would.
 *
 * The extension is appended from {@link WINDOWS_EXECUTABLE_EXTENSIONS} rather
 * than from `PATHEXT`, because the two can disagree — an operator can narrow
 * `PATHEXT` in a way that hides the file we can execute — and because the order
 * has to be a *resolution* order for us, not a security policy for the shell.
 *
 * A `.com`/`.exe` extension is preferred over `.bat`/`.cmd` and over the
 * extensionless form. That ordering is load-bearing on a host that has both
 * types: the npm prefix contains an extensionless POSIX shell script next to
 * the `.cmd`, and matching that first finds a file Windows cannot execute and
 * the shim parser cannot read.
 */
export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    // An explicit path is used as given; there is no search to do.
    return isReadableFile(command) ? command : undefined;
  }
  const extensions = isWindows() ? WINDOWS_EXECUTABLE_EXTENSIONS : [""];
  const candidates = extensions.length === 1 ? [command] : [...extensions.map((e) => command + e), command];

  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (isReadableFile(full)) return full;
    }
  }
  return undefined;
}

function isReadableFile(path: string): boolean {
  try {
    readFileSync(path, { flag: "r" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the script an npm `.cmd` shim runs.
 *
 * npm generates one fixed shape, and the line that matters ends in `%*`:
 *
 * ```bat
 * endLocal & goto #_undefined_# 2>NUL || ... & "%_prog%"  "%dp0%\node_modules\pkg\lib\cli.mjs" %*
 * ```
 *
 * Only that shape is accepted. A shim that does not match — a hand-written one,
 * a different package manager, a future npm change — returns `undefined` so the
 * caller can refuse. Guessing at the contents of a file that is about to decide
 * what gets executed is not a trade worth making, and a shim is a file inside a
 * global install directory, not a file jaa controls.
 */
export function parseNpmShim(shimPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return undefined;
  }
  const match = /&\s+"%_prog%"\s+"([^"]+)"\s+%\*/.exec(text);
  const script = match?.[1];
  if (script === undefined) return undefined;

  // `%dp0%` is the shim's own directory, which npm substitutes at run time.
  const dir = shimPath.slice(0, shimPath.lastIndexOf("\\") + 1);
  const relative = script.replace(/%dp0%/g, "");
  const resolved = relative === "" ? undefined : join(dir, relative);
  return resolved !== undefined && isReadableFile(resolved) ? resolved : undefined;
}

export class SpawnResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpawnResolutionError";
  }
}

/**
 * Turn a command name and its arguments into something spawnable on this host.
 *
 * Throws {@link SpawnResolutionError} rather than falling back to a shell when a
 * command cannot be resolved or a shim cannot be understood. The alternative —
 * trying `cmd /c` and hoping — is the injection path documented above.
 */
export function resolveSpawn(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnPlan {
  // POSIX: `spawn` already searches `PATH` and takes a real argv. Nothing to do.
  if (!isWindows()) {
    return { command, args: [...args], viaShim: false };
  }

  const resolved = findExecutable(command, env);
  if (resolved === undefined) {
    throw new SpawnResolutionError(
      `could not find "${command}" on PATH. A language server has to be installed and reachable; ` +
        `install it, or configure an absolute path. jaa does not fall back to a shell to launch it.`,
    );
  }

  // A real executable spawns natively and needs no help.
  if (/\.(exe|com)$/i.test(resolved)) {
    return { command: resolved, args: [...args], viaShim: false };
  }

  // Anything else on Windows is a batch file, which Node will not spawn. npm
  // shims are a batch file that runs node against a script, so unwrap it.
  const script = parseNpmShim(resolved);
  if (script === undefined) {
    throw new SpawnResolutionError(
      `"${resolved}" is a batch file that is not a recognised npm shim, so jaa cannot tell what it would run. ` +
        `Refusing rather than executing it through a shell. Configure an absolute path to a real executable, ` +
        `or to the script it runs.`,
    );
  }

  return {
    command: process.execPath,
    args: [script, ...args],
    viaShim: true,
    shim: resolved,
  };
}

export interface SpawnResult {
  child: ChildProcessWithoutNullStreams;
  /** The plan actually used, for diagnostics and for tests. */
  plan: SpawnPlan;
}

/**
 * Spawn a long-lived child (a language server, an MCP server) with stdio pipes.
 *
 * `runProcess` is the wrong tool for this: it collects stdout into a string and
 * returns, which is right for `git --version` and wrong for a process that talks
 * to jaa for the rest of the session.
 *
 * The environment is inherited deliberately. This is a server the operator
 * installed and configured — it needs `PATH`, and often a runtime it found by
 * looking at one. The sandbox options live in `runProcess`, which is where a
 * command with a shell is actually run.
 */
export function spawnPipe(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; spawnImpl?: typeof spawn },
): SpawnResult {
  const plan = resolveSpawn(command, args, options.env);
  const impl = options.spawnImpl ?? spawn;
  const child = impl(plan.command, plan.args, {
    cwd: options.cwd,
    stdio: "pipe",
    windowsHide: true,
    ...(options.env !== undefined ? { env: options.env } : {}),
  }) as ChildProcessWithoutNullStreams;
  return { child, plan };
}
