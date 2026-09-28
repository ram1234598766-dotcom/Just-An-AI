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

export interface ForkOptions {
  targetTurn?: number;
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

/** Configuration for checkpoint retention */
export interface CheckpointConfig {
  retentionDays?: number;
  maxCheckpointsPerSession?: number;
  autoCleanup?: boolean;
  enabled?: boolean;
}
