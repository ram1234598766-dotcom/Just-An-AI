export {
  clampResult,
  createTask,
  descendantsOf,
  ancestorsOf,
  listTasks,
  loadTask,
  newTaskId,
  removeTask,
  saveTask,
  tasksDir,
  taskFilePath,
  treeUsage,
  ISOLATION_KINDS,
  MAX_RESULT_CHARS,
  TASK_ID_PATTERN,
  TASK_STATUSES,
} from "./task.js";
export type { IsolationKind, Task, TaskStatus } from "./task.js";

export { displaySubagentReport, scanSubagentReport, INJECTION_MARKER } from "./inject.js";
export type { ScanResult } from "./inject.js";

export {
  createWorktree,
  removeWorktree,
  worktreeCapability,
  BRANCH_PREFIX,
  MAX_WORKTREES_PER_RUN,
  safeBranchName,
} from "./isolation.js";
export type { IsolationFailure, IsolationFailureReason, IsolationResult, WorktreeHandle, WorktreeRequest } from "./isolation.js";

export {
  clampLimits,
  effectiveToolNames,
  runPool,
  DEFAULT_POOL_LIMITS,
  HARD_CEILING,
} from "./pool.js";
export type { PoolEvent, PoolLimits, PoolOptions, PoolResult, PoolTaskResult, Worker, WorkerContext, WorkerOutput } from "./pool.js";

export { TeamChannel, MAX_MESSAGE_CHARS } from "./team.js";
export type { ClaimResult, TeamMessage } from "./team.js";

export {
  mergeFanoutReport,
  parseCsvLine,
  parseFanoutFile,
  requireFanoutOptIn,
  runFanout,
  FanoutNotEnabledError,
  MAX_FANOUT_ROWS,
} from "./fanout.js";
export type { FanoutContext, FanoutFormat, FanoutIssue, FanoutOptions, FanoutReport, FanoutRow, ParseResult } from "./fanout.js";

export { buildReviewPrompt, isAccepted, parseVerdict, reviewOutput, REVIEW_VERDICTS } from "./review.js";
export type { ReviewOptions, ReviewOutcome, ReviewRequest, Reviewer, ReviewVerdict } from "./review.js";

export {
  collectResults,
  detachProcess,
  isStale,
  isStopped,
  requestStop,
  summarize,
  unfinishedTasks,
  DetachError,
  DEFAULT_STALE_AFTER_MS,
  STOP_POLL_MS,
} from "./background.js";
export type { CollectedResult, DetachHandle, DetachRequest, Summary } from "./background.js";
