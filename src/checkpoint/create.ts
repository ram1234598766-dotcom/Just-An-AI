import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext, ToolDefinition } from "../tools/types.js";
import { confinePath } from "../tools/registry.js";
import { defaultToolDefinitions } from "../tools/index.js";
import { MUTATING_TOOLS } from "../permissions/rules.js";
import { cleanupCheckpoints, listCheckpoints, recordCheckpoint } from "./store.js";
import { jaaPaths } from "../config/paths.js";
import type { Session } from "../agent/session.js";
import type { CheckpointDisplayInfo } from "./types.js";

/**
 * Where the store keeps its session directories, named the same way `store.ts`
 * names it.
 *
 * `store.ts` owns that layout; this copy exists only so the session-end wrapper
 * can ask whether a store exists *without* creating one. The retention test in
 * `tests/checkpoint.test.ts` fails if the two ever disagree.
 */
const CHECKPOINTS_DIRNAME = "checkpoints";

/**
 * Create a checkpoint before each mutating tool call.
 *
 * This is the core of Phase 14's time-travel system. It runs after a tool call
 * is validated but before it's executed, so restore can always target a specific
 * moment in the session. The checkpoint is tagged with turn and tool-call id for
 * precise restoration.
 */
export function createCheckpoint(
  session: Session,
  tool: ToolDefinition,
  args: unknown,
  ctx: ToolContext,
  turn: number,
  toolCallId: string,
): void {
  // Only record checkpoints for tools that can mutate the workspace.
  //
  // `MUTATING_TOOLS` is the single source of truth: the permission engine
  // already uses it to decide which calls need a decision, so a snapshot is
  // taken for exactly the calls that can change the tree. Two of them (`bash`
  // and `git_diff`) have no single file target, and fall out below.
  if (!MUTATING_TOOLS.includes(tool.name)) {
    return;
  }

  // Validate the path is within the workspace before checkpointing.
  try {
    // Use the tool's input schema to validate args
    if (!tool.schema) return;
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) return;
    const path = targetPathOf(parsed.data);
    if (path === undefined) return;

    // Record the checkpoint for the file the tool will touch.
    // A tool with no single file target (`bash`, `git_diff`) has no `path`
    // argument, so it is skipped: a shell command can touch anything, and the
    // Phase 14 spec puts Bash side effects explicitly out of scope of rewind,
    // exactly as Claude Code documents it.
    recordCheckpoint(session, confinePath(ctx, path), turn, toolCallId);
  } catch {
    // Path validation or schema parsing failed — no checkpoint. A file the tool
    // is about to create has no prior content to snapshot, which is correct:
    // there is no earlier state for restore to return it to.
  }
}

/**
 * Record a checkpoint for a mutating tool call identified only by name.
 *
 * {@link createCheckpoint} is the primary entry point: it holds the tool's own
 * schema, so it can tell whether a call names a single file. This variant is for
 * a call site that has only the tool name and the raw arguments, so it looks the
 * schema up in the built-in tool set — the same `ToolDefinition` objects
 * `createRegistry` executes — and validates the arguments against it before
 * taking the same confinement and snapshot path.
 *
 * That lookup is the whole point, not a convenience. A snapshot target has to
 * come from the shape a tool *declares*, so a `path` the tool does not declare
 * names nothing: zod strips the keys a schema does not have, and `bash` and
 * `git_diff` declare no `path` at all. Reading the raw arguments instead recorded
 * a snapshot for `{ command: "x", path: "f.txt" }` — a file the shell call never
 * touches — which a later rewind would then write back.
 *
 * Never throws. A checkpoint is a best-effort safety net taken before a tool
 * runs, so failing to take one must not abort the call it was protecting.
 */
export async function createCheckpointFromTool(
  session: Session,
  toolName: string,
  toolCallId: string,
  turn: number,
  ctx: ToolContext,
  args: unknown,
): Promise<void> {
  if (!MUTATING_TOOLS.includes(toolName)) {
    return;
  }

  try {
    // The same rule `createCheckpoint` applies to the schema it holds: the target
    // is read off what the tool declares, never off whatever key the raw
    // arguments happen to carry. `bash` and `git_diff` declare no `path`, so a
    // smuggled one names no target and there is nothing to snapshot.
    const path = targetPathOf(declaredInputOf(toolName, args));
    if (path === undefined) return;
    recordCheckpoint(session, confinePath(ctx, path), turn, toolCallId);
  } catch {
    // Path outside the root, or a file with no prior content — no checkpoint.
  }
}

/**
 * Prune a session's checkpoints once the session is closed.
 *
 * Delegates to the store's retention window so there is one retention policy,
 * not a second no-op. See {@link cleanupCheckpoints} for what "recent" means.
 *
 * ## Why it checks the store first
 *
 * `checkpointDir` is pure, and `listCheckpoints` answers an absent store with an
 * empty list, so `cleanupCheckpoints` would find nothing to prune either way.
 * The guard is kept because that is a property of the code it happens to call,
 * not of this function's contract: it says "no store, nothing to prune" here,
 * where that is what is meant, rather than relying on the read path to keep
 * saying it. One `existsSync`, on a path that is absent for every session which
 * never snapshotted a file.
 *
 * Retaining and reclaiming are also this function's only jobs: it never
 * rewinds, and it never removes a session, a snapshot inside the window, or a
 * file that is not a readable checkpoint.
 */
export function cleanupSessionCheckpoints(session: Session): void {
  if (!existsSync(join(jaaPaths().root, CHECKPOINTS_DIRNAME, session.id))) return;
  cleanupCheckpoints(session);
}

/**
 * Validate that a checkpoint can be restored.
 *
 * This function checks if the checkpoint exists and is valid for restoration.
 */
export function validateCheckpointForRestore(session: Session, turn: number): boolean {
  return listCheckpoints(session).some((cp) => cp.turn === turn);
}

/**
 * Get checkpoint information for display in the TUI.
 *
 * This function returns formatted information about checkpoints for the user
 * to understand what's available for rewind operations.
 */
export function getCheckpointInfo(session: Session): CheckpointDisplayInfo {
  const checkpoints = listCheckpoints(session);

  if (checkpoints.length === 0) {
    return {
      total: 0,
      currentTurn: 1,
      oldestTurn: 1,
      newestTurn: 1,
      filesAffected: 0,
    };
  }

  const turns = checkpoints.map((cp) => cp.turn);
  return {
    total: checkpoints.length,
    currentTurn: Math.max(...turns),
    oldestTurn: Math.min(...turns),
    newestTurn: Math.max(...turns),
    filesAffected: new Set(checkpoints.map((cp) => cp.file)).size,
  };
}

/**
 * The path a validated tool call is about to write, if it has one.
 *
 * `ToolDefinition.schema` is a `z.ZodType<unknown>`, so the parsed output is
 * `unknown` and the field is read through a runtime check rather than a cast.
 */
function targetPathOf(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const path: unknown = (input as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : undefined;
}

/**
 * The built-in tools' schemas by name, built on first use.
 *
 * `MUTATING_TOOLS` is a closed list of jaa's own tool names, so a miss here
 * cannot mean an unvalidated third-party tool slipped through: it means the name
 * is not one of ours, and a name we do not define declares no target.
 */
let builtinSchemas: ReadonlyMap<string, ToolDefinition["schema"]> | undefined;

function schemaOf(toolName: string): ToolDefinition["schema"] | undefined {
  if (builtinSchemas === undefined) {
    const schemas = new Map<string, ToolDefinition["schema"]>();
    for (const tool of defaultToolDefinitions()) {
      // First definition wins rather than throwing on a repeat, because nothing
      // in this file is allowed to throw at a tool call.
      if (!schemas.has(tool.name)) schemas.set(tool.name, tool.schema);
    }
    builtinSchemas = schemas;
  }
  return builtinSchemas.get(toolName);
}

/**
 * The arguments as the named tool's own schema defines them.
 *
 * `undefined` for a name that is not one of ours and for arguments that do not
 * fit, because both mean the same thing to the caller: no declared target, so
 * nothing to snapshot. That is exactly how {@link createCheckpoint} treats the
 * schema it holds directly, which is the agreement this function exists to keep.
 */
function declaredInputOf(toolName: string, args: unknown): unknown {
  const schema = schemaOf(toolName);
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(args);
  return parsed.success ? parsed.data : undefined;
}
