import { z } from "zod";
import { isHookEvent } from "./events.js";
import type { HookEvent } from "./events.js";

/** A decision a hook can return for a blocking event. */
export type HookDecision = "allow" | "deny" | "ask";

/**
 * A hook handler. Discriminated by `kind`:
 *
 *   command  — spawn a binary, feed the payload on stdin, read stdout + exit code
 *   http     — POST the payload to a URL, read the response body
 *   prompt   — ask a model to judge the payload (needs a resolved model)
 *   mcp      — call a tool on an already-connected MCP server
 *   agent    — spawn a subagent to produce a verdict (needs a resolved model)
 */
export type HookHandler = CommandHook | HttpHook | PromptHook | McpHook | AgentHook;

export interface CommandHook {
  kind: "command";
  command: string;
  args?: string[];
  /** Shell form (no `args`) runs through `sh -c`; exec form spawns directly. */
  shell?: "sh" | "powershell";
  timeoutMs?: number;
}

export interface HttpHook {
  kind: "http";
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface PromptHook {
  kind: "prompt";
  prompt: string;
  model?: { provider?: string; model?: string };
  timeoutMs?: number;
}

export interface AgentHook {
  kind: "agent";
  prompt: string;
  model?: { provider?: string; model?: string };
  timeoutMs?: number;
}

export interface McpHook {
  kind: "mcp";
  server: string;
  tool: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}

/** A matcher filters when a hook group fires. */
export type HookMatcher =
  | { type: "all" }
  | { type: "exact"; value: string }
  | { type: "list"; values: string[] }
  | { type: "regex"; pattern: string };

/**
 * One hook group: a matcher plus the handlers that run when it matches.
 *
 * `if` is Claude Code's permission-rule-syntax filter ("Bash(rm *)"). It is
 * evaluated only on tool events and narrows the group further.
 */
export interface HookGroup {
  matcher?: string;
  if?: string;
  handlers: HookHandler[];
}

/**
 * A hook entry in config: an event name and the groups that fire for it.
 *
 * `once` removes the entry after its first successful run (Claude Code
 * semantics for skill frontmatter).
 */
export interface HookEntry {
  event: HookEvent;
  groups: HookGroup[];
  once?: boolean;
}

/** The decision output of a hook, mirroring Claude Code's JSON shape. */
export interface HookDecisionOutput {
  decision?: HookDecision;
  reason?: string;
  /** PreToolUse: replace the tool's arguments before it runs. */
  updatedInput?: Record<string, unknown>;
  /** PreToolUse/PostToolUse: extra context appended to the conversation. */
  additionalContext?: string;
  /** Surface to the user. */
  systemMessage?: string;
}

/** A single handler's result within a fired group. */
export interface HookHandlerResult {
  index: number;
  handler: HookHandler;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  stdout?: string;
  error?: string;
  decision?: HookDecisionOutput;
}

/** The outcome of firing one group. */
export interface HookGroupResult {
  matcher: string;
  fired: boolean;
  handlers: HookHandlerResult[];
  decision?: HookDecision;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  systemMessage?: string;
}

/** The payload handed to every hook. Mirrors Claude Code's common fields. */
export interface HookPayload {
  hookEventName: HookEvent;
  sessionId: string;
  cwd: string;
  timestamp: string;
  permissionMode?: string;
  /**
   * `SessionStart` only: why the session started.
   *
   * `matcherField` filters a `SessionStart` group on this field, so without it
   * only a wildcard matcher could ever fire. Claude Code's vocabulary is
   * `"startup" | "resume" | "clear"`; the field is a plain string so a caller
   * that grows another reason does not have to widen the type first, and
   * `buildPayload` defaults it to `"startup"`.
   */
  startupSource?: string;
  /** Tool events only. */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolCallId?: string;
  toolResponse?: string;
  /** User prompt events only. */
  prompt?: string;
  /** Subagent events only. */
  agentId?: string;
  agentType?: string;
  /** Compaction events only. */
  compacted?: boolean;
  /** Notification events only. */
  level?: "info" | "warning" | "error";
  message?: string;
}

/** Per-handler limits. */
export interface HookTimeouts {
  commandMs: number;
  httpMs: number;
  promptMs: number;
  agentMs: number;
  mcpMs: number;
}

export const DEFAULT_TIMEOUTS: HookTimeouts = {
  commandMs: 60_000,
  httpMs: 60_000,
  promptMs: 30_000,
  agentMs: 60_000,
  mcpMs: 60_000,
};

/** Maximum stdout a single hook may emit, clamped like any tool result. */
export const MAX_HOOK_OUTPUT = 80_000;

// --- Config schemas -------------------------------------------------------

const hookMatcherSchema = z.string().min(1).optional();

const hookIfSchema = z.string().min(1).optional();

const commandHookSchema = z
  .object({
    kind: z.literal("command"),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    shell: z.enum(["sh", "powershell"]).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .refine((h) => h.shell !== "powershell" || process.platform === "win32", {
    message: "shell powershell is only valid on win32",
  });

const httpHookSchema = z.object({
  kind: z.literal("http"),
  /**
   * Absolute http(s) only, because that is the only shape `fetch` accepts.
   *
   * A bare `z.url()` also admits a relative reference like `/foo`, which parses
   * as a URL but is rejected by the transport at request time — the hook would
   * then deny with a confusing network error instead of the config being
   * rejected as malformed. `z.regexes.httpProtocol` is zod's own http(s) scheme
   * pattern rather than a hand-rolled one, and supplying it as `protocol` also
   * switches on zod's `://` guard, which is what keeps `http:host` and
   * `https:/path` out: the URL parser would otherwise normalise both into
   * valid http(s) URLs.
   */
  url: z.url({ protocol: z.regexes.httpProtocol }),
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const modelSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

const promptHookSchema = z.object({
  kind: z.literal("prompt"),
  prompt: z.string().min(1),
  model: modelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const agentHookSchema = z.object({
  kind: z.literal("agent"),
  prompt: z.string().min(1),
  model: modelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const mcpHookSchema = z.object({
  kind: z.literal("mcp"),
  server: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const hookHandlerSchema = z.discriminatedUnion("kind", [
  commandHookSchema,
  httpHookSchema,
  promptHookSchema,
  agentHookSchema,
  mcpHookSchema,
]);

const hookGroupSchema = z
  .object({
    matcher: hookMatcherSchema,
    if: hookIfSchema,
    handlers: z.array(hookHandlerSchema).min(1),
    /** Remove this group after its first successful run. */
    once: z.boolean().optional(),
  })
  .refine((g) => g.handlers.length > 0, { message: "a hook group needs at least one handler" });

/** A raw, unvalidated hook config: `{ "<Event>": [ group, ... ] }`. */
export type RawHookConfig = Record<string, HookGroup[]>;

export const hookConfigSchema = z.record(z.string(), z.array(hookGroupSchema).min(1));

/** A validated hook entry with its event name resolved. */
export interface ValidatedHookEntry {
  event: HookEvent;
  groups: HookGroup[];
}

/**
 * Rebuild a validated group as a `HookGroup`, keeping only the keys that are
 * actually set.
 *
 * Zod infers `matcher?: string | undefined` from `.optional()`, but `HookGroup`
 * declares a bare `matcher?: string`. Under `exactOptionalPropertyTypes` the
 * two are not mutually assignable, so the parsed value is rebuilt key by key
 * rather than assigned through — widening `HookGroup` to admit an explicit
 * `undefined` would lose a real guarantee about the rest of the codebase.
 */
function toHookGroup(group: z.infer<typeof hookGroupSchema>): HookGroup {
  const out: HookGroup = { handlers: group.handlers.map(toHookHandler) };
  if (group.matcher !== undefined) out.matcher = group.matcher;
  if (group.if !== undefined) out.if = group.if;
  return out;
}

/**
 * Rebuild a validated model selector, dropping the absent half.
 *
 * `provider` and `model` are independently optional, so a provider-only
 * selector must not arrive carrying `model: undefined`.
 */
function toModelSpec(model: z.infer<typeof modelSchema>): { provider?: string; model?: string } {
  const out: { provider?: string; model?: string } = {};
  if (model.provider !== undefined) out.provider = model.provider;
  if (model.model !== undefined) out.model = model.model;
  return out;
}

/**
 * Rebuild a validated handler as its `HookHandler` variant, keeping only the
 * keys that are actually set. Same reason as `toHookGroup`: the switch is
 * exhaustive over `kind`, so adding a field to a handler interface without
 * updating this function is a compile error rather than a silent widening.
 */
function toHookHandler(handler: z.infer<typeof hookHandlerSchema>): HookHandler {
  switch (handler.kind) {
    case "command": {
      const out: CommandHook = { kind: "command", command: handler.command };
      if (handler.args !== undefined) out.args = handler.args;
      if (handler.shell !== undefined) out.shell = handler.shell;
      if (handler.timeoutMs !== undefined) out.timeoutMs = handler.timeoutMs;
      return out;
    }
    case "http": {
      const out: HttpHook = { kind: "http", url: handler.url };
      if (handler.headers !== undefined) out.headers = handler.headers;
      if (handler.timeoutMs !== undefined) out.timeoutMs = handler.timeoutMs;
      return out;
    }
    case "prompt": {
      const out: PromptHook = { kind: "prompt", prompt: handler.prompt };
      if (handler.model !== undefined) out.model = toModelSpec(handler.model);
      if (handler.timeoutMs !== undefined) out.timeoutMs = handler.timeoutMs;
      return out;
    }
    case "agent": {
      const out: AgentHook = { kind: "agent", prompt: handler.prompt };
      if (handler.model !== undefined) out.model = toModelSpec(handler.model);
      if (handler.timeoutMs !== undefined) out.timeoutMs = handler.timeoutMs;
      return out;
    }
    case "mcp": {
      const out: McpHook = { kind: "mcp", server: handler.server, tool: handler.tool };
      if (handler.input !== undefined) out.input = handler.input;
      if (handler.timeoutMs !== undefined) out.timeoutMs = handler.timeoutMs;
      return out;
    }
  }
}

/**
 * One issue as a single line, naming where in the config it was found.
 *
 * `prefix` is prepended verbatim, so a caller parsing one group at a time can
 * supply its own position (`PreToolUse.0.`) and still produce exactly the paths
 * `parseHookConfig` produces for the same mistake. One format, so a report from
 * the loader and a report from the CLI are the same sentence.
 */
function formatIssue(prefix: string, issue: z.core.$ZodIssue): string {
  return `${prefix}${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

/** A layer parsed for the loader: what validated, and what did not. */
export interface HookLayerParse {
  entries: ValidatedHookEntry[];
  /** One line per rejected item, in the `parseHookConfig` message format. */
  errors: string[];
}

/**
 * Validate a raw hook config object.
 *
 * Returns `{ ok: true, entries }` on success or `{ ok: false, errors }` on
 * failure. Never throws: a malformed config must warn, not crash jaa.
 *
 * All-or-nothing, by design: it answers "is this config valid?", which is the
 * question `jaa hooks list` asks. The loader does not want that answer — see
 * `parseHookConfigResilient` for why.
 */
export function parseHookConfig(input: unknown): { ok: true; entries: ValidatedHookEntry[] } | { ok: false; errors: string[] } {
  if (input === undefined || input === null) return { ok: true, entries: [] };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["hooks config must be an object mapping event names to handler groups"] };
  }
  const result = hookConfigSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => formatIssue("", issue)),
    };
  }
  const entries: ValidatedHookEntry[] = [];
  for (const [event, groups] of Object.entries(result.data)) {
    if (!isHookEvent(event)) {
      // Unknown events are skipped, not rejected: a config written against a
      // future jaa version must not break the current one.
      continue;
    }
    entries.push({ event, groups: groups.map(toHookGroup) });
  }
  return { ok: true, entries };
}

/**
 * Validate a raw hook config, keeping every entry that survives on its own.
 *
 * `parseHookConfig` is all-or-nothing: one malformed group anywhere fails the
 * whole object, so a single typo costs the operator every other hook in the
 * layer. A deny rule written beside a broken handler would silently stop
 * running, and nothing anywhere said so. The loader uses this instead and
 * reports `errors`, so the surviving hooks are live and the mistake is named.
 *
 * Where the line between "skip this one" and "this layer is unusable" is drawn:
 *
 *   - A **group** or a **handler** that fails to validate is skipped on its
 *     own. Siblings describe different work and are unaffected — that is the
 *     entire point of this function.
 *   - An **event key whose value is not an array of groups**, or is an empty
 *     array, is reported and that event contributes nothing. Nothing under
 *     such a key can be salvaged, so there is no item to skip; it is also
 *     always a mistake, because an event was named and nothing was written.
 *   - A `hooks` value that is not an object at all stays a hard error, as in
 *     `parseHookConfig`: the layer's top-level shape is wrong, so there is
 *     nothing to iterate and nothing to keep.
 *
 * An unknown event name is still skipped in silence, so a config written
 * against a future jaa keeps working — the same rule `parseHookConfig` applies.
 * An event whose groups all fail contributes no entry: registering an event
 * with zero groups would claim a watcher that is not there.
 */
export function parseHookConfigResilient(input: unknown): HookLayerParse {
  const entries: ValidatedHookEntry[] = [];
  const errors: string[] = [];
  if (input === undefined || input === null) return { entries, errors };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { entries, errors: ["hooks config must be an object mapping event names to handler groups"] };
  }
  for (const [event, rawGroups] of Object.entries(input as Record<string, unknown>)) {
    if (!isHookEvent(event)) continue;
    if (!Array.isArray(rawGroups)) {
      errors.push(`${event}: expected an array of hook groups, got ${describeValue(rawGroups)}`);
      continue;
    }
    if (rawGroups.length === 0) {
      errors.push(`${event}: declared with no hook groups`);
      continue;
    }
    const groups: HookGroup[] = [];
    for (const [index, rawGroup] of rawGroups.entries()) {
      const parsed = hookGroupSchema.safeParse(rawGroup);
      if (!parsed.success) {
        errors.push(...parsed.error.issues.map((issue) => formatIssue(`${event}.${index}.`, issue)));
        continue;
      }
      groups.push(toHookGroup(parsed.data));
    }
    if (groups.length === 0) continue;
    entries.push({ event, groups });
  }
  return { entries, errors };
}

/** A short, safe description of a rejected value, for the message only. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}
