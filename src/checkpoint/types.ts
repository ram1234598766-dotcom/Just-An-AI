import type { Session } from "../agent/session.js";
import type { CheckpointEntry } from "./store.js";

/** Checkpoint system types for Phase 14 */

export interface ForkableTurn {
  turn: number;
  available: boolean;
  checkpointCount: number;
}

export interface CheckpointTurnInfo {
  turn: number;
  totalCheckpoints: number;
  filesAffected: string[];
  checkpointDetails: CheckpointEntry[];
}

export interface RestoredFileResult {
  filePath: string;
  turn: number;
  toolCallId: string;
  status: "restored" | "skipped";
}

export interface RestoredMessageResult {
  content: string;
  turn: number;
  timestamp: string;
  role: string;
}

export interface RestoredFilesResult {
  restored: RestoredFileResult[];
  skipped: RestoredFileResult[];
  errors: string[];
}

export interface RestoredMessagesResult {
  restored: RestoredMessageResult[];
  skipped: RestoredMessageResult[];
  errors: string[];
}

export interface RestoreResult {
  success: boolean;
  files: RestoredFilesResult;
  messages: RestoredMessagesResult;
  errors: string[];
}

export interface RestoreFilesOptions {
  preserveCurrent?: boolean;
}

export interface ForkOptions {
  targetTurn?: number;
  restore?: boolean;
}

export interface ForkResult {
  forkedSession: Session;
  restored: boolean;
  errors: string[];
}

export interface CheckpointDisplayInfo {
  total: number;
  currentTurn: number;
  oldestTurn: number;
  newestTurn: number;
  filesAffected: number;
}

/** Union type for all checkpoint-related operations */
export type CheckpointOperation =
  | { type: "restore"; turn: number; options?: RestoreFilesOptions }
  | { type: "fork"; turn?: number; restore?: boolean }
  | { type: "list"; limit?: number };

/** Status of a checkpoint restoration operation */
export interface CheckpointStatus {
  turn: number;
  filePath: string;
  toolCallId: string;
  status: "restored" | "skipped" | "error";
  message?: string;
}

/** Statistics about checkpoint storage */
export interface CheckpointStats {
  totalSessions: number;
  totalCheckpoints: number;
  totalFiles: number;
  oldestCheckpoint?: string;
  newestCheckpoint?: string;
}

/** Configuration for checkpoint retention */
export interface CheckpointConfig {
  retentionDays?: number;
  maxCheckpointsPerSession?: number;
  autoCleanup?: boolean;
  enabled?: boolean;
}

/** Event types for checkpoint system */
export type CheckpointEvent =
  | { type: "checkpoint-created"; session: Session; filePath: string; turn: number }
  | { type: "checkpoint-restored"; session: Session; turn: number; filesRestored: number }
  | { type: "session-forked"; sourceSession: Session; forkedSession: Session; turn: number }
  | { type: "checkpoint-cleanup"; session: Session; cleanedFiles: number };

/** Payload for checkpoint events */
export interface CheckpointEventPayload {
  hookEventName: string;
  sessionId: string;
  timestamp: string;
  turn: number;
  filePath?: string;
  filesRestored?: number;
  sourceSessionId?: string;
  forkedSessionId?: string;
}