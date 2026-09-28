import { createSession, saveSession } from "../agent/session.js";
import type { Session } from "../agent/session.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";
import type { ToolContext } from "../tools/types.js";
import { listCheckpoints } from "./store.js";
import type { CheckpointEntry } from "./store.js";
import { restoreToTurn } from "./restore.js";
import type { CheckpointTurnInfo, ForkOptions, ForkResult, ForkableTurn } from "./types.js";

/**
 * Branch a session from `options.targetTurn` into a new session id.
 *
 * Nothing mutable is shared with the source. The fork gets its own id, its own
 * file, and a deep copy of the transcript, so appending a message to one session
 * can never be observed through the other and no array or object is aliased
 * between them. Checkpoints are per-session, so the fork starts with an empty
 * checkpoint directory: its working tree is rewound by {@link forkAndRestore},
 * not by inheriting the source's history.
 *
 * Turns are 1-based message positions, the same mapping
 * `restoreMessagesToTurn` uses. An out-of-range turn yields an empty transcript
 * plus an error rather than a silent full copy.
 *
 * This function only ever branches the transcript, so it reports
 * `restored: false`. Rewinding the working tree is {@link forkAndRestore}'s
 * job, and the caller picks between the two: a flag on their shared options
 * could not say which of them it was called, so it could never be honoured
 * either way.
 */
export function forkSession(session: Session, options: ForkOptions = {}): ForkResult {
  const errors: string[] = [];
  const messages = messagesThroughTurn(session, options.targetTurn, errors);
  const forked = createSession({
    messages: messages.map(copyMessage),
    ...(session.provider !== undefined ? { provider: session.provider } : {}),
    ...(session.model !== undefined ? { model: session.model } : {}),
  });
  saveSession(forked);
  return { forkedSession: forked, restored: false, errors };
}

/**
 * Fork, then rewind the working tree to the same turn.
 *
 * Needs a `ToolContext` because restore writes: every file goes back through
 * `confinePath` exactly as any other write in a session does. The source
 * session is left alone — it keeps its full transcript and its checkpoints.
 */
export function forkAndRestore(session: Session, ctx: ToolContext, options: ForkOptions = {}): ForkResult {
  const fork = forkSession(session, options);
  const errors = [...fork.errors];
  let restored = false;

  if (options.targetTurn === undefined) {
    errors.push("fork without a targetTurn has no working-tree state to rewind; it is a conversation branch only");
  } else {
    // Both halves stated, because the two options are independent and this call
    // site is the reason that has to stay true.
    //
    // `preserveCurrent: true` — the source keeps its transcript, and the fork
    // already holds the rewound one, so nothing is destroyed on either side.
    //
    // `reportOnly: false` — this is a rewind, so the working tree IS written.
    // Left to the default it would still be written, but the point of the option
    // existing is that "write nothing" and "keep the transcript" are separate
    // requests; a fork that stopped asking for the write would produce a fork
    // whose conversation is rewound and whose tree is not.
    const result = restoreToTurn(session, options.targetTurn, ctx, { preserveCurrent: true, reportOnly: false });
    restored = result.success;
    errors.push(...result.errors);
  }

  return { forkedSession: fork.forkedSession, restored, errors };
}

/** Turns this session can be forked or rewound to, oldest first. */
export function listForkableTurns(session: Session): ForkableTurn[] {
  const perTurn = new Map<number, number>();
  for (const checkpoint of listCheckpoints(session)) {
    perTurn.set(checkpoint.turn, (perTurn.get(checkpoint.turn) ?? 0) + 1);
  }
  return [...perTurn.entries()]
    .map(([turn, checkpointCount]) => ({ turn, available: true, checkpointCount }))
    .sort((a, b) => a.turn - b.turn);
}

/** What one turn's checkpoints cover, for the `/rewind` picker. */
export function getCheckpointInfoForTurn(session: Session, turn: number): CheckpointTurnInfo {
  const checkpointDetails: CheckpointEntry[] = listCheckpoints(session).filter((cp) => cp.turn === turn);
  return {
    turn,
    totalCheckpoints: checkpointDetails.length,
    filesAffected: [...new Set(checkpointDetails.map((cp) => cp.file))],
    checkpointDetails,
  };
}

/** The messages up to and including `targetTurn`, or an error if it cannot be. */
function messagesThroughTurn(session: Session, targetTurn: number | undefined, errors: string[]): ChatMessage[] {
  if (targetTurn === undefined) return session.messages;
  if (!Number.isInteger(targetTurn) || targetTurn < 0 || targetTurn > session.messages.length) {
    errors.push(`turn ${targetTurn} is out of range for session ${session.id} (${session.messages.length} messages)`);
    return [];
  }
  return session.messages.slice(0, targetTurn);
}

/** Copy every field so the fork aliases nothing. `ToolCall` is all scalars. */
function copyMessage(message: ChatMessage): ChatMessage {
  const copy: ChatMessage = { role: message.role, content: message.content };
  if (message.toolCallId !== undefined) copy.toolCallId = message.toolCallId;
  if (message.toolCalls !== undefined) {
    copy.toolCalls = message.toolCalls.map((call): ToolCall => ({ id: call.id, name: call.name, arguments: call.arguments }));
  }
  return copy;
}
