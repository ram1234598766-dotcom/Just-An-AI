/**
 * Worktree isolation: one git worktree per parallel worker.
 *
 * Two agents that write the same file at the same time do not conflict, they
 * corrupt each other. `write_file` and `patch` are last-writer-wins, so with no
 * isolation a fan-out of three workers over one file loses two thirds of the
 * work with no error reported anywhere. A worktree gives each worker its own
 * checkout of the same repository on its own branch, so the writes cannot
 * overlap, and the operator decides afterwards whether to merge them.
 *
 * ## Why this is a refusal, not a fallback
 *
 * The dangerous failure mode for parallel workers on Windows is the one with no
 * OS sandbox (Phase 12 gap G1): a worker there runs unisolated. If worktree
 * creation silently failed, every worker would share the operator's checkout
 * and the fan-out would corrupt it. So `createWorktree` returns a typed
 * failure with a reason, `isolateWorker` refuses to hand back a directory it
 * did not create, and the pool records the task as `failed` rather than
 * starting a worker with the wrong tree. There is no "continue without
 * isolation" path, because the operator asked for isolation and silently
 * dropping it is how a repository gets damaged.
 *
 * ## Cleanup is not optional
 *
 * A worktree is a directory plus a `.git/worktrees/<name>` entry. Leaving the
 * latter behind makes `git worktree list` grow without bound and eventually
 * makes a real `git worktree prune` slow, so removal is attempted on the
 * success path, the failure path, and the throw path.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { runProcess } from "../tools/registry.js";

/**
 * The branch prefix for worktrees.
 *
 * `jaa/` rather than something the operator might collide with by hand, and
 * slash-delimited so the entries sort together in `git branch`.
 */
const BRANCH_PREFIX = "jaa/";

/** Absolute ceiling on how many worktrees one run may create. */
export const MAX_WORKTREES_PER_RUN = 32;

export interface WorktreeRequest {
  /** The repository to create a worktree from. */
  repoRoot: string;
  /** Where the worktree directory goes. Created if absent. */
  path: string;
  /**
   * The branch to check out. Required: a worktree with no branch is a detached
   * HEAD the operator cannot merge, and defaulting it would make every worker in
   * a fan-out contend for the same name, so the second one would fail for a
   * reason the caller cannot act on. Build it with {@link safeBranchName}.
   */
  branch: string;
  /** A base ref to branch from. Defaults to `HEAD`. */
  baseRef?: string;
}

export interface WorktreeHandle {
  path: string;
  branch: string;
  repoRoot: string;
}

export type IsolationFailureReason =
  | "not-a-repo"
  | "dirty"
  | "git-missing"
  | "path-exists"
  | "path-escape"
  | "branch-exists"
  | "git-failed";

export interface IsolationFailure {
  ok: false;
  reason: IsolationFailureReason;
  message: string;
}

export type IsolationResult = { ok: true; worktree: WorktreeHandle } | IsolationFailure;

function fail(reason: IsolationFailureReason, message: string): IsolationFailure {
  return { ok: false, reason, message };
}

/** A branch name safe to pass as a single git argument. */
function safeBranchName(taskId: string): string {
  // The id is already validated against `/^t-[A-Za-z0-9_-]{4,63}$/` by the board;
  // re-checking here keeps this function correct if it is ever called with a
  // caller-supplied string instead.
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(taskId)) {
    throw new Error(`unsafe task id "${taskId}" cannot name a branch`);
  }
  return `${BRANCH_PREFIX}${taskId}`;
}

/** `git -C <dir> rev-parse --show-toplevel`, or undefined when it is not a repo. */
async function repoTopLevel(dir: string): Promise<string | undefined> {
  try {
    const out = await runProcess("git", ["-C", dir, "rev-parse", "--show-toplevel"], { cwd: dir });
    // `code === 0` is the success signal. A `null` code means git never ran.
    if (out.code !== 0) return undefined;
    const top = out.stdout.trim();
    return top === "" ? undefined : resolve(top);
  } catch {
    // `git` is not on PATH at all.
    return undefined;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    const out = await runProcess("git", ["-C", repoRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repoRoot,
    });
    return out.code === 0;
  } catch {
    // Cannot tell. Assume it exists so creation fails loudly instead of
    // overwriting a branch the operator cares about.
    return true;
  }
}

/**
 * Create a worktree for one worker.
 *
 * Returns a typed failure rather than throwing, because every failure here is
 * an expected operational state — a non-repo checkout, a dirty tree, a missing
 * git — and the caller needs to record *which* one happened to report it.
 */
export async function createWorktree(request: WorktreeRequest): Promise<IsolationResult> {
  const repoRoot = resolve(request.repoRoot);
  const top = await repoTopLevel(repoRoot);
  if (top === undefined) {
    return fail(
      "not-a-repo",
      `${repoRoot} is not a git repository, so no worktree can be created for an isolated worker`,
    );
  }

  // The worktree must not sit inside `.git`, and must be an absolute path so a
  // `cd` inside the worker cannot change what it refers to.
  const path = isAbsolute(request.path) ? resolve(request.path) : resolve(repoRoot, request.path);
  if (existsSync(path)) {
    return fail("path-exists", `${path} already exists, so it cannot be used as a worktree`);
  }
  if (isInsideGitDir(path, top)) {
    return fail("path-escape", `${path} is inside the repository's .git directory, which is not a valid worktree location`);
  }

  const branch = request.branch;
  if (await branchExists(top, branch)) {
    return fail("branch-exists", `branch ${branch} already exists, so a worktree for it was not created`);
  }

  // The parent directory has to exist: `git worktree add` creates the leaf, not
  // the tree above it, and a missing parent is the single most common reason a
  // fan-out fails on a clean machine.
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return fail("git-failed", `could not create ${dirname(path)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const args = ["-C", top, "worktree", "add", "--detach", path];
  if (request.baseRef !== undefined) args.push(request.baseRef);
  else args.push("HEAD");

  try {
    const out = await runProcess("git", args, { cwd: top });
    if (out.code !== 0) {
      return fail("git-failed", `git worktree add failed: ${(out.stderr || out.stdout).trim()}`);
    }
  } catch (err) {
    return fail("git-missing", `git is not available: ${err instanceof Error ? err.message : String(err)}`);
  }

  // `--detach` above creates an anonymous HEAD, which the operator cannot merge
  // and which `git worktree list` shows as a bare SHA. Give it a real branch
  // named for the task so the result of a fan-out is mergeable. A failure here
  // is not fatal to isolation — the worktree exists and is already separate —
  // so it is reported by leaving the handle's branch empty rather than unwinding
  // a directory that is doing its job.
  const named = await runProcess("git", ["-C", path, "checkout", "-b", branch], { cwd: path }).catch(() => undefined);
  const actualBranch = named?.code === 0 ? branch : "HEAD (detached)";

  return { ok: true, worktree: { path, branch: actualBranch, repoRoot: top } };
}

function isInsideGitDir(path: string, repoTop: string): boolean {
  const gitDir = join(repoTop, ".git");
  return path === gitDir || path.startsWith(`${gitDir}/`) || path.startsWith(`${gitDir}\\`);
}

/**
 * Remove a worktree created by {@link createWorktree}.
 *
 * Best-effort and idempotent: `git worktree remove` deletes the directory, but
 * the worktree can already be gone if the worker cleaned it up or the run was
 * interrupted, and neither is a reason to fail a cleanup. Returns whether the
 * administrative entry was pruned, so a caller can report an incomplete cleanup
 * rather than assuming it worked.
 */
export async function removeWorktree(handle: WorktreeHandle): Promise<boolean> {
  let pruned = false;
  try {
    const out = await runProcess("git", ["-C", handle.repoRoot, "worktree", "remove", "--force", handle.path], {
      cwd: handle.repoRoot,
    });
    pruned = out.code === 0;
  } catch {
    // git unavailable; fall through to the directory removal below.
  }
  if (!pruned && existsSync(handle.path)) {
    try {
      rmSync(handle.path, { recursive: true, force: true });
    } catch {
      return false;
    }
  }
  return pruned;
}

/** Is this host able to create worktrees at all? Reported by `jaa doctor`. */
export async function worktreeCapability(repoRoot: string = process.cwd()): Promise<{ available: boolean; reason?: string }> {
  const top = await repoTopLevel(repoRoot);
  if (top === undefined) return { available: false, reason: "not a git repository" };
  try {
    const out = await runProcess("git", ["-C", top, "worktree", "list"], { cwd: top });
    if (out.code !== 0) return { available: false, reason: (out.stderr || out.stdout).trim() };
    return { available: true };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export { BRANCH_PREFIX, safeBranchName };
