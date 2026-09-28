import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolContext, ToolDefinition } from "./types.js";
import type { ToolDef } from "../providers/types.js";

const execFileAsync = promisify(execFile);

/** Result cap applied to every tool so a single tool never floods context. */
export const MAX_TOOL_OUTPUT = 80_000;

/** Clamp output to MAX_TOOL_OUTPUT chars, marking truncation. */
export function clampOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated]`;
}

/**
 * Resolves `p` (absolute or relative to `ctx.cwd`) and refuses any path whose
 * real location escapes `ctx.root`. Path traversal is the prime tool security
 * boundary, and "real location" is the operative phrase.
 *
 * ## Containment is a filesystem question, not a string question
 *
 * The decision is made on where the path *points*, never on how it is spelled.
 * That ordering matters because the lexical answer is not evidence of safety:
 * `workspace/link/evil.dll` is textually inside the workspace while `link` is a
 * symlink or Windows junction to `C:\Windows\System32`, so a lexically admitted
 * path is a write primitive out of the root. No amount of string comparison can
 * see that, so the filesystem is consulted on every call — the previous design
 * skipped it whenever the lexical answer said "in", and that skip was the hole.
 *
 * `realpathSync.native` is what answers it rather than string munging: it
 * expands an 8.3 alias, resolves a symlink or junction, and canonicalises a
 * case-flipped segment, all from state only the OS holds.
 *
 * ## Why the 8.3 fix survives
 *
 * On Windows one directory is reachable as both `C:\Users\Mrityunjay\...` and
 * `C:\Users\MRITYU~1\...`; `process.cwd()` hands out whichever form it has, and
 * a snapshot recorded on one run can carry the other. Compared as strings those
 * look like unrelated trees, so a file genuinely inside the root read as an
 * escape and was refused. Comparing *resolved* forms admits both spellings of
 * the same file, because they resolve to one location. That is the same
 * comparison, just asked of the filesystem instead of the string — and it is
 * strictly stronger, since a genuine escape does not become one just because its
 * real location was substituted.
 *
 * ## The remaining properties
 *
 * - `..` is collapsed lexically by `resolve` *before* the filesystem is touched,
 *   so no alias can be used to climb out: `root/../../etc/passwd` is already
 *   outside by the time realpath sees it, and stays outside after.
 * - Resolution errors fail closed. `realpath` only fails for the whole path when
 *   even the filesystem root cannot be resolved — a denied ACL or an unmounted
 *   volume — and a write there would fail too, so refusing costs nothing that
 *   was working. The guess is never used to admit.
 * - The returned path is the caller's own resolved spelling, not the canonical
 *   one: the value is handed to `fs` and compared against snapshot data, and
 *   rewriting it would change every caller's result for no confinement gain.
 */
export function confinePath(ctx: ToolContext, p: string): string {
  if (p.includes("\0")) throw new Error(`path contains a null byte: ${JSON.stringify(p)}`);
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
  const root = resolve(ctx.root);

  // Resolved against resolved, so the answer is a property of the location and
  // not of the spelling. `resolved` is part of the condition rather than a
  // fallback: a side the filesystem could not answer for is a side that cannot
  // prove containment, and admitting on the strength of the other one would put
  // the hole back.
  const realRoot = canonicalRoot(root);
  const realAbs = realLocation(abs);
  if (realRoot.resolved && realAbs.resolved && isWithin(realRoot.path, realAbs.path)) return abs;

  throw new Error(`path escapes the workspace root: ${p}`);
}

/** Where `p` really is, and whether the filesystem was able to say. */
interface RealLocation {
  /** Every spelling collapsed onto the one the filesystem reports. */
  readonly path: string;
  /** False when no ancestor could be resolved and `path` is an unanswered guess. */
  readonly resolved: boolean;
}

/**
 * Canonical form of a workspace root, memoised.
 *
 * The root is the one path whose real location is stable for the lifetime of a
 * session, so re-resolving it on every tool call is a syscall spent on an
 * answer that cannot change. Nor can the agent re-point it: doing so means
 * writing to the *parent* of the workspace, which is the escape this function
 * exists to prevent. A caller that changes roots between calls gets a different
 * key, so the entry is invalidated by being irrelevant rather than by ageing.
 *
 * An unresolved root is deliberately not cached — it is a question to be
 * re-asked, not an answer to be remembered.
 */
const rootCache = new Map<string, RealLocation>();

/**
 * Bound on the cache. A session has one root, so this is never reached in
 * production; a test run that opens many temp roots can cross it, and a wholesale
 * reset is the right trade there — correctness does not depend on what is cached,
 * only speed does.
 */
const MAX_CACHED_ROOTS = 16;

function canonicalRoot(root: string): RealLocation {
  const hit = rootCache.get(root);
  if (hit !== undefined) return hit;
  const location = realLocation(root);
  if (location.resolved) {
    if (rootCache.size >= MAX_CACHED_ROOTS) rootCache.clear();
    rootCache.set(root, location);
  }
  return location;
}

/**
 * Collapse every spelling of a path onto the one the filesystem reports.
 *
 * `realpathSync.native` is what makes this work rather than string munging: on
 * Windows it resolves an 8.3 alias to its long name, and on POSIX it resolves
 * a symlink. Aliases are per-volume, recorded state, so there is no way to
 * expand one by inspecting the path.
 *
 * A path need not exist — `confinePath` is asked about the file a write is
 * *about* to create — so the deepest existing ancestor is resolved instead and
 * the missing tail is re-appended verbatim. The tail cannot itself hide an
 * alias, because an alias only exists for a directory that exists, and every
 * existing ancestor has just been resolved. That walk is also what catches a
 * link planted mid-path: for `root/link/new/deep.txt` it resolves `root/link`,
 * lands wherever that points, and re-appends `new/deep.txt` onto *there*.
 *
 * A path with no resolvable ancestor at all reports `resolved: false`, which
 * `confinePath` treats as an inability to prove containment and refuses.
 */
export function canonicalPath(p: string): string {
  return realLocation(p).path;
}

function realLocation(p: string): RealLocation {
  const original = resolve(p);
  let current = original;
  const tail: string[] = [];

  for (;;) {
    try {
      const real = realpathSync.native(current);
      return { path: tail.length === 0 ? real : join(real, ...tail), resolved: true };
    } catch {
      const parent = dirname(current);
      // `dirname` is a fixed point at the filesystem root, so this terminates.
      if (parent === current) return { path: original, resolved: false };
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether `abs` is `root` itself or something under it. */
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export interface Registry {
  /** Advertise every registered tool to the model. */
  list(): ToolDef[];
  /** Execute a tool by name with a JSON-encoded arguments string. */
  execute(name: string, argsJson: string, ctx: ToolContext): Promise<string>;
}

/**
 * A context-free tool registry: tools are registered once, and each execution
 * receives a fresh ToolContext. Argument failures and handler throws come back
 * as result strings (never reject out of the loop), so the model can recover.
 */
export function createRegistry(tools: ToolDefinition[]): Registry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return [...byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    async execute(name, argsJson, ctx) {
      const tool = byName.get(name);
      if (!tool) return clampOutput(`unknown tool "${name}"`);

      let input: unknown;
      try {
        input = argsJson === "" ? {} : JSON.parse(argsJson);
      } catch {
        return clampOutput(`tool "${name}": arguments are not valid JSON: ${argsJson}`);
      }

      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("; ");
        return clampOutput(`tool "${name}": invalid arguments — ${issues}`);
      }

      try {
        return clampOutput(await tool.run(parsed.data, ctx));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return clampOutput(`tool "${name}" failed: ${msg}`);
      }
    },
  };
}

export interface RunProcessOptions {
  cwd: string;
  timeoutMs?: number;
  maxOutput?: number;
  /**
   * OS-level confinement for this process. When supplied, the command is
   * wrapped in the host's sandbox mechanism. With `enforcement: "require"`
   * (the default) a host that cannot sandbox refuses to run the command at
   * all, rather than running it wide and reporting the degradation.
   */
  sandbox?: {
    writableRoots?: string[];
    readableRoots?: string[];
    network?: boolean;
    envPassthrough?: string[];
    enforcement?: "require" | "best-effort";
  };
}

/** Runs an external binary with an arg array (no shell) — used by bash/git tools. */
export async function runProcess(
  command: string,
  args: string[],
  opts: RunProcessOptions,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const max = opts.maxOutput ?? MAX_TOOL_OUTPUT;

  let spawnCommand = command;
  let spawnArgs = args;
  let sandboxNote: string | undefined;

  try {
    if (opts.sandbox) {
      const { detectCapability } = await import("../sandbox/detect.js");
      const { wrapCommand } = await import("../sandbox/apply.js");
      const capability = await detectCapability();
      const policy = {
        writableRoots: opts.sandbox.writableRoots ?? [],
        readableRoots: opts.sandbox.readableRoots ?? opts.sandbox.writableRoots ?? [],
        network: opts.sandbox.network ?? false,
        cwd: opts.cwd,
        envPassthrough: opts.sandbox.envPassthrough ?? [],
      };
      const wrap = wrapCommand(policy, capability, command, args, opts.sandbox.enforcement ?? "require");
      if (!wrap.wrapped && wrap.refusal !== undefined) {
        // Fail closed: refuse rather than run without the requested isolation.
        return { stdout: "", stderr: wrap.refusal, code: null };
      }
      if (wrap.wrapped) {
        spawnCommand = wrap.command;
        spawnArgs = wrap.args;
        sandboxNote = `[sandbox: ${wrap.mechanism}]`;
      } else {
        // best-effort with no mechanism: say so on stderr, never silently.
        sandboxNote = `[sandbox: UNAVAILABLE on this host - command ran without isolation]`;
      }
    }

    const result = await execFileAsync(spawnCommand, spawnArgs, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: max * 2,
      windowsHide: true,
      encoding: "utf8",
    });
    const stderr = sandboxNote !== undefined ? `${sandboxNote}\n${String(result.stderr)}` : String(result.stderr);
    return { stdout: String(result.stdout), stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    const stderr = sandboxNote !== undefined ? `${sandboxNote}\n${e.stderr ?? ""}` : (e.stderr ?? "");
    return {
      stdout: e.stdout ?? "",
      stderr,
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}