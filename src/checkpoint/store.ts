import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jaaPaths } from "../config/paths.js";
import type { Session } from "../agent/session.js";
import type { CheckpointConfig } from "./types.js";

/**
 * Checkpoint storage for jaa's time-travel and fork capabilities.
 *
 * Checkpoints are content-addressable snapshots of every file the agent writes
 * during a session. They live under ~/.jaa/checkpoints/<session>/ and are
 * deduplicated by hash so an unchanged file costs nothing.
 *
 * Security: path confinement via confinePath, and restored files go through
 * the same Phase 11 permission gate as any other write.
 */

const CHECKPOINTS_DIR = "checkpoints";

/**
 * The base directory for a session's checkpoints.
 *
 * Pure: it computes a path and does not touch the filesystem. A read must not
 * create a store, or listing a session that never snapshotted a file would
 * leave behind an empty `~/.jaa/checkpoints/<id>/` — one per run, forever,
 * since the TUI lists checkpoints on mount. Only {@link recordCheckpoint}
 * creates the directory.
 */
export function checkpointDir(session: Session): string {
  return join(jaaPaths().root, CHECKPOINTS_DIR, session.id);
}

/** Create the session's checkpoint directory, if it is not already there. */
function ensureCheckpointDir(session: Session): string {
  const dir = checkpointDir(session);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Content-addressed snapshot of a file path. */
export function snapshotPath(session: Session, filePath: string): string {
  return join(checkpointDir(session), `${hashFile(filePath)}.json`);
}

/**
 * Hash a file's content, so an unchanged file maps to the same snapshot.
 *
 * Exported because the snapshot name is part of the on-disk contract: restore
 * addresses a snapshot by `<hash>.json`.
 */
export function hashFile(path: string): string {
  return hashContent(readFileSync(path, "utf8"));
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Record a checkpoint for a file written during a turn.
 *
 * Called before the tool runs, so `content` is the content the file has to go
 * back to. The snapshot is keyed by that content's hash, so re-recording the
 * same bytes costs nothing.
 *
 * The checkpoint is stored with a key that includes turn and tool-call id so
 * restore can target a specific moment in the session.
 */
export function recordCheckpoint(
  session: Session,
  filePath: string,
  turn: number,
  toolCallId: string,
): void {
  const content = readFileSync(filePath, "utf8");
  // The only write path, so it is the only one that creates the store.
  const path = join(ensureCheckpointDir(session), `${hashContent(content)}.json`);
  if (existsSync(path)) return; // Already checkpointed

  const data: CheckpointData = {
    file: filePath,
    turn,
    toolCallId,
    timestamp: new Date().toISOString(),
    content,
  };

  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8" });
}

/**
 * List all checkpoints for a session, newest-first.
 *
 * Each entry includes the file, turn, tool-call id, and timestamp so the TUI
 * can render a meaningful summary per turn.
 *
 * A snapshot is on-disk state that may have been hand-edited, truncated, or
 * written by a version with a different shape, so a file that does not parse
 * as a checkpoint is skipped rather than surfaced. Unparseable JSON was already
 * skipped by the `catch`; the guard closes the same hole for JSON that parses
 * to the wrong shape. It matters because the sort below reads `timestamp` and
 * `turn` off every entry: a snapshot missing `timestamp` would otherwise throw
 * `localeCompare` out of the sort, so one bad file broke the whole listing —
 * and with it the rewind picker, which lists on mount.
 *
 * The guard checks exactly the fields a {@link CheckpointEntry} carries, not
 * `content`. Whether a snapshot holds restorable bytes is a question for the
 * write path, which owns it and validates again in `restore.ts`; a snapshot
 * that lists and is then refused there is reported as an error, where a
 * snapshot silently dropped here would be invisible.
 */
export function listCheckpoints(session: Session): CheckpointEntry[] {
  const dir = checkpointDir(session);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir, { withFileTypes: true });
  const entries: CheckpointEntry[] = [];

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;

    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, file.name), "utf8"));
      if (!isCheckpointEntry(parsed)) continue;
      entries.push({
        file: parsed.file,
        turn: parsed.turn,
        toolCallId: parsed.toolCallId,
        timestamp: parsed.timestamp,
        path: file.name,
      });
    } catch {
      // Corrupt checkpoint file — skip but keep it so a user can't easily
      // delete all checkpoints by overwriting a random .json file.
      continue;
    }
  }

  entries.sort((a, b) => (b.turn - a.turn) || b.timestamp.localeCompare(a.timestamp));
  return entries;
}

/**
 * The shape `listCheckpoints` needs in order to list and order an entry.
 *
 * Mirrors the guard `restore.ts` applies before writing, minus `content`: see
 * `listCheckpoints` for why the two are not the same check.
 */
function isCheckpointEntry(value: unknown): value is Omit<CheckpointEntry, "path"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.file === "string" &&
    record.file !== "" &&
    // `turn` is subtracted in the sort, so a non-finite value would make the
    // comparator return NaN and leave the order unspecified.
    typeof record.turn === "number" &&
    Number.isFinite(record.turn) &&
    typeof record.toolCallId === "string" &&
    // Compared with `localeCompare` in the sort; absent is the case that
    // originally threw out of it.
    typeof record.timestamp === "string"
  );
}

/**
 * How many snapshots a session keeps by default.
 *
 * Dedup already makes an unchanged file free, so the growth that remains is one
 * file per genuine edit. A few hundred covers a long session with room to rewind
 * far back, and caps a runaway loop from filling the disk.
 */
export const DEFAULT_MAX_CHECKPOINTS_PER_SESSION = 200;

/**
 * Prune a session's snapshots to its retention window and report how many went.
 *
 * Phase 14's mitigation for snapshot disk growth: hash dedup plus a bounded
 * window, pruned when the session closes. The newest
 * `maxCheckpointsPerSession` snapshots are kept — ordered exactly as
 * `listCheckpoints` orders them, by descending turn then descending timestamp —
 * and the rest are deleted.
 *
 * Only files directly inside this session's own checkpoint directory are ever
 * removed, and only ones that parse as a checkpoint. A file that does not parse
 * is left alone, matching `listCheckpoints`: corrupting one snapshot must not
 * become a way to delete the others.
 */
export function cleanupCheckpoints(session: Session, options: CheckpointConfig = {}): number {
  const limit = retentionLimit(options);
  // Newest-first, so the tail is the oldest and the only part that is prunable.
  const entries = listCheckpoints(session);
  if (entries.length <= limit) return 0;

  const dir = resolve(checkpointDir(session));
  let removed = 0;
  for (const entry of entries.slice(limit)) {
    // `entry.path` is a bare file name from readdir, so this cannot escape in
    // practice; the check is what makes that a guarantee rather than an
    // assumption about every directory on the way to it.
    const target = resolve(dir, entry.path);
    if (dirname(target) !== dir) continue;
    try {
      unlinkSync(target);
      removed++;
    } catch {
      // Already gone, or not ours to remove. Retention is best-effort and must
      // never fail a session close.
    }
  }
  return removed;
}

/** A retention limit is a positive integer; anything else is the default. */
function retentionLimit(options: CheckpointConfig): number {
  const configured = options.maxCheckpointsPerSession;
  if (configured === undefined) return DEFAULT_MAX_CHECKPOINTS_PER_SESSION;
  if (!Number.isInteger(configured) || configured < 1) return DEFAULT_MAX_CHECKPOINTS_PER_SESSION;
  return configured;
}

export interface CheckpointEntry {
  file: string;
  turn: number;
  toolCallId: string;
  timestamp: string;
  path: string;
}

export interface CheckpointData {
  file: string;
  turn: number;
  toolCallId: string;
  timestamp: string;
  /** The file's bytes as of the moment the checkpoint was taken. */
  content: string;
}

export interface RestoredFiles {
  files: Array<{ filePath: string; turn: number; toolCallId: string }>;
  skipped: Array<{ filePath: string; turn: number; toolCallId: string }>;
}