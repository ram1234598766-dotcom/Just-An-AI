import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { confinePath } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { Session } from "../agent/session.js";
import { loadSession, saveSession } from "../agent/session.js";
import { checkpointDir, listCheckpoints } from "./store.js";
import type { CheckpointData, CheckpointEntry } from "./store.js";
import type { ChatMessage } from "../providers/types.js";
import type { RestoredFileResult, RestoredFilesResult, RestoredMessageResult, RestoredMessagesResult, RestoreResult } from "./types.js";

/** What a file restore can be told to do beyond computing its plan. */
export interface RestoreFileOptions {
  /**
   * Report-only: compute exactly which files would be written and which
   * snapshots would be skipped, and write NOTHING.
   *
   * The plan is computed, not guessed: each selected snapshot is still read,
   * validated and confined, so an unreadable snapshot or one naming a path
   * outside `ctx.root` is still reported as an error rather than advertised as
   * a file that would be restored. Only the two filesystem calls are skipped.
   */
  reportOnly?: boolean;
}

/**
 * Restore files to the state they held at the end of `targetTurn`.
 *
 * `targetTurn` is inclusive and means exactly what it means for the transcript:
 * `restoreMessagesToTurn` keeps messages 1..targetTurn and drops the rest, so
 * the working tree must be the tree as it stood once every write of turns
 * 1..targetTurn had been applied.
 *
 * A snapshot tagged turn T is taken BEFORE the write of turn T, so it holds the
 * content the file had going into that write — the state at the end of the last
 * turn that wrote it. The snapshot that carries a file back to the end of turn
 * T is therefore the one taken before the first write AFTER T: the snapshot for
 * that file with the smallest turn tag strictly greater than `targetTurn`. A
 * file with no such snapshot was never written after `targetTurn`, so it already
 * holds the right bytes and is reported as skipped rather than rewritten.
 *
 * Only that one snapshot per file is applied. A file written on several later
 * turns has several snapshots, and writing all of them would replay its history
 * forward and land on the newest content instead of the target's.
 *
 * Every write goes through `confinePath`, so a snapshot naming a path outside
 * `ctx.root` is refused rather than written, and the caller's permission
 * decision is the same one every other write in a session goes through -- the
 * caller owns it by wrapping the tool executor, exactly as Phase 11 does.
 *
 * `ctx` is required rather than optional: restore cannot write anything without
 * the caller stating which root the write is confined to.
 *
 * ## `preserveCurrent` is not consulted here
 *
 * `preserveCurrent` is a statement about the stored transcript, so it is
 * honoured by {@link restoreMessagesToTurn} and has no meaning on the file
 * path. A caller that wants a dry run of the working tree asks for
 * `reportOnly`, which is the one option on this function that writes nothing.
 * `jaa fork --restore` is the reason that distinction has to stay sharp: it
 * passes `preserveCurrent: true` precisely because it WANTS the tree written
 * (the fork already holds the rewound transcript), and it calls
 * `restoreToTurn`, not this function, so it is unaffected either way.
 */
export function restoreFilesToTurn(
  session: Session,
  targetTurn: number,
  ctx: ToolContext,
  options: RestoreFileOptions = {},
): RestoredFilesResult {
  const reportOnly = options.reportOnly === true;
  const checkpoints = listCheckpoints(session);
  const toRestore = selectRestoreTargets(checkpoints, targetTurn);
  const toReport = (cp: CheckpointEntry): RestoredFileResult => ({
    filePath: cp.file,
    turn: cp.turn,
    toolCallId: cp.toolCallId,
    status: "skipped",
  });

  if (toRestore.length === 0) {
    // Either the session never wrote a file, or nothing was written after
    // `targetTurn`. Both are the same outcome: the working tree already is the
    // tree as of that turn. Reporting an error here would make
    // `RestoreResult.success` lie about a rewind that asked for nothing.
    return { restored: [], skipped: checkpoints.map(toReport), errors: [] };
  }

  const dir = checkpointDir(session);
  const restored: RestoredFileResult[] = [];
  const errors: string[] = [];
  const applied = new Set(toRestore.map((cp) => cp.path));

  for (const checkpoint of toRestore) {
    let target: string;
    let data: CheckpointData;
    try {
      // A snapshot is on-disk state from an earlier run, so the one field that
      // becomes a filesystem write is validated before it is used.
      const parsed: unknown = JSON.parse(readFileSync(join(dir, checkpoint.path), "utf8"));
      if (!isCheckpointData(parsed)) {
        throw new Error(`snapshot ${checkpoint.path} is not a readable checkpoint`);
      }
      data = parsed;
      target = confinePath(ctx, data.file);
    } catch (err) {
      errors.push(`Failed to restore ${checkpoint.file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!reportOnly) {
      try {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data.content, "utf8");
      } catch (err) {
        errors.push(`Failed to restore ${checkpoint.file}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    // `filePath` is the confined target, so a report names the file that would
    // be written rather than the snapshot that was read. Under `reportOnly` this
    // entry is the plan, not a record of a write.
    restored.push({ filePath: target, turn: checkpoint.turn, toolCallId: checkpoint.toolCallId, status: "restored" });
  }

  return {
    restored,
    // Everything the target selection did not apply: snapshots that predate or
    // belong to the target turn, and the later snapshots of a file whose
    // earliest post-target snapshot was the one applied.
    skipped: checkpoints.filter((cp) => !applied.has(cp.path)).map(toReport),
    errors,
  };
}

/**
 * Pick, for each file, the snapshot that rewinds it to the end of `targetTurn`.
 *
 * A snapshot is eligible only if it was taken after the target turn. Among a
 * file's eligible snapshots the earliest turn wins, because a snapshot's tag
 * is the turn whose write it precedes.
 */
function selectRestoreTargets(checkpoints: readonly CheckpointEntry[], targetTurn: number): CheckpointEntry[] {
  const chosen = new Map<string, CheckpointEntry>();
  for (const cp of checkpoints) {
    if (cp.turn <= targetTurn) continue;
    const current = chosen.get(cp.file);
    if (current === undefined || cp.turn < current.turn) {
      chosen.set(cp.file, cp);
    }
  }
  return [...chosen.values()];
}

/**
 * Restore conversation messages to a specific turn.
 *
 * Turns are 1-based message positions. `preserveCurrent` leaves the stored
 * session untouched and only reports what a rewind would do, so an operator can
 * look at a turn without destroying the tail; the default rewrites the session
 * to the messages up to `targetTurn`. It guards the transcript ONLY — the
 * working tree is a different question, answered by `reportOnly` on
 * {@link restoreFilesToTurn}.
 */
export function restoreMessagesToTurn(
  session: Session,
  targetTurn: number,
  options: { preserveCurrent?: boolean } = {},
): RestoredMessagesResult {
  // Load the current session to get all messages
  const currentSession = loadSession(session.id);
  if (!currentSession) {
    return {
      restored: [],
      skipped: [],
      errors: [`Session not found: ${session.id}`],
    };
  }

  const allMessages = currentSession.messages;
  if (!Number.isInteger(targetTurn) || targetTurn < 0 || targetTurn > allMessages.length) {
    return {
      restored: [],
      skipped: [],
      errors: [`turn ${targetTurn} is out of range for session ${session.id} (${allMessages.length} messages)`],
    };
  }

  const relevantMessages = allMessages.slice(0, targetTurn);

  if (options.preserveCurrent !== true) {
    const restoredSession: Session = {
      ...currentSession,
      messages: relevantMessages,
      updatedAt: new Date().toISOString(),
    };
    saveSession(restoredSession);
  }

  return {
    restored: relevantMessages.map((msg, index) => toRestoredMessage(msg, index + 1)),
    skipped: allMessages.slice(targetTurn).map((msg, index) => toRestoredMessage(msg, targetTurn + index + 1)),
    errors: [],
  };
}

/** What {@link restoreToTurn} can be told to do beyond applying the plan. */
export interface RestoreOptions extends RestoreFileOptions {
  /**
   * Leave the stored transcript as it is and report what a rewind would do.
   * Says nothing about the working tree: see {@link restoreFilesToTurn}.
   */
  preserveCurrent?: boolean;
}

/**
 * Restore both files and messages to a specific turn.
 *
 * This is the main restoration function that restores the entire state of a
 * session to a previous turn, respecting all Phase 11 and Phase 12 constraints.
 *
 * The two options guard different halves of the state, and neither implies the
 * other:
 *
 * - `preserveCurrent` keeps the stored transcript. The working tree is still
 *   written, because that is what `forkAndRestore` asks for: it branches the
 *   transcript itself and needs the tree rewound.
 * - `reportOnly` writes nothing at all. Both halves of the result are then the
 *   plan that would have been applied, which is the only way to see a rewind
 *   before committing to it.
 */
export function restoreToTurn(
  session: Session,
  targetTurn: number,
  ctx: ToolContext,
  options: RestoreOptions = {},
): RestoreResult {
  // Restore files
  const filesResult = restoreFilesToTurn(session, targetTurn, ctx, { reportOnly: options.reportOnly === true });

  // Restore messages. A report-only run reports the transcript too, so a dry
  // run cannot quietly rewrite the session and leave the tree alone.
  const messagesResult = restoreMessagesToTurn(session, targetTurn, {
    preserveCurrent: options.preserveCurrent === true || options.reportOnly === true,
  });

  return {
    success: filesResult.errors.length === 0 && messagesResult.errors.length === 0,
    files: filesResult,
    messages: messagesResult,
    errors: [...filesResult.errors, ...messagesResult.errors],
  };
}

function toRestoredMessage(message: ChatMessage, turn: number): RestoredMessageResult {
  return {
    content: message.content,
    turn,
    timestamp: new Date().toISOString(),
    role: message.role,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckpointData(value: unknown): value is CheckpointData {
  if (!isRecord(value)) return false;
  return (
    typeof value.file === "string" &&
    typeof value.turn === "number" &&
    typeof value.toolCallId === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.content === "string"
  );
}
