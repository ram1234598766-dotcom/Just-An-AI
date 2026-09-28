import type { McpClient } from "../mcp/client.js";
import { BLOCKING_EVENTS } from "./events.js";
import type { HookEvent } from "./events.js";
import { parseMatcher, matcherMatches, ifFilterApplies, matcherField } from "./matcher.js";
import { runHookHandler } from "./run.js";
import { DEFAULT_TIMEOUTS } from "./types.js";
import type {
  HookDecision,
  HookDecisionOutput,
  HookGroup,
  HookGroupResult,
  HookHandlerResult,
  HookPayload,
  HookTimeouts,
} from "./types.js";

/** What one fired group contributes to the next action. */
export interface HookGroupApplication {
  ok: boolean;
  decision?: HookDecision;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  systemMessage?: string;
}

/** The decision for one event once every group has run. */
export interface HookChainResult {
  /**
   * The most restrictive verdict across the fired groups, `deny` > `ask` >
   * `allow`, or undefined when no group had an opinion. A deny is final and
   * ends the chain.
   */
  decision?: HookDecision;
  /** Why that decision was reached, when a handler said so. */
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  systemMessage?: string;
  /** Per-group results in declaration order, for `jaa hooks test`. */
  groups: HookGroupResult[];
}

/**
 * Decision precedence, most restrictive first.
 *
 * Handlers in a group run concurrently via `Promise.all`, so declaration order
 * carries no authority over the outcome. Ranking by restriction instead is what
 * makes a deny binding: `[allow, deny]` must resolve to `deny`, or a group
 * holding both verdicts would let the allow cancel the deny and the gate would
 * fail open on the exact case it exists to catch.
 *
 * The same ranking orders the groups themselves, one level up: a group asking
 * for human confirmation must not be cancelled by an earlier group that merely
 * allowed. Both levels read from this one list, so the two can never disagree
 * about what "more restrictive" means.
 */
const DECISION_PRECEDENCE: readonly HookDecision[] = ["deny", "ask", "allow"];

/** Whether `candidate` is more restrictive than `incumbent`. */
function outranks(candidate: HookDecision, incumbent: HookDecision): boolean {
  return DECISION_PRECEDENCE.indexOf(candidate) < DECISION_PRECEDENCE.indexOf(incumbent);
}

/**
 * The decision a group reached, and the reason from the handler that won it.
 *
 * Ties inside one precedence level keep the earliest handler, so the trace
 * still names the first handler that had something to say.
 */
function winningDecision(handlers: readonly HookHandlerResult[]): { decision: HookDecision; reason?: string } | undefined {
  for (const level of DECISION_PRECEDENCE) {
    const winner = handlers.find((h) => h.decision?.decision === level);
    if (winner === undefined) continue;
    const reason = winner.decision?.reason;
    return reason === undefined ? { decision: level } : { decision: level, reason };
  }
  return undefined;
}

/**
 * The decision a group reaches for `event`, and the reason behind it.
 *
 * A handler that crashed or timed out returned no verdict at all, so on its own
 * it ranks nowhere: it is absent from `winningDecision` and the group's outcome
 * would come entirely from its siblings. On a blocking event that is the
 * fail-open the spec forbids — a sibling `allow` is a verdict about a call the
 * crashed handler never got to judge, so the group must resolve to `deny`
 * whatever else it holds. On every other event the failure contributes nothing
 * and the surviving verdicts stand, which is the passthrough the same spec
 * sentence requires of a post event.
 *
 * An explicit `deny` already says no, so it keeps its own reason rather than
 * having the failure's reason overwrite a more informative one.
 */
function groupVerdict(group: HookGroupResult, blocking: boolean): { decision: HookDecision; reason?: string } | undefined {
  const decided = winningDecision(group.handlers);
  if (!blocking || decided?.decision === "deny") return decided;
  const failed = group.handlers.filter((h) => !h.ok);
  if (failed.length === 0) return decided;
  return { decision: "deny", reason: `a ${group.matcher} hook failed: ${failed.map((h) => h.error ?? h.handler.kind).join("; ")}` };
}

/**
 * The first rewrite in a group, by declaration order.
 *
 * Rewrites have no severity to rank them by, so unlike decisions the earliest
 * handler to produce one keeps it. A handler that rewrites without deciding
 * still contributes.
 */
function firstRewrite(handlers: readonly HookHandlerResult[]): HookDecisionOutput {
  for (const h of handlers) {
    const out = h.decision;
    if (out === undefined) continue;
    if (out.updatedInput !== undefined) return out;
    if (out.additionalContext !== undefined) return out;
    if (out.systemMessage !== undefined) return out;
  }
  return {};
}

/**
 * Apply the outcomes of a hook group to the next action.
 *
 * For PreToolUse and PermissionRequest, the group's decision is the most
 * restrictive one any of its handlers returned (deny, then ask, then allow).
 * If no handler decides, the permission engine's decision stands. A handler
 * that failed returns no verdict and so is invisible here — turning a failure
 * into a deny needs the event, which is why that step lives in
 * `decideFromHooks` rather than in this event-blind helper.
 *
 * For PostToolUse, the first handler that returns a rewrite (updatedInput,
 * additionalContext, systemMessage) wins, and the result is applied to the
 * transcript.
 *
 * The decision and the rewrite are resolved independently, because they are
 * independent outputs: a handler returning both `{"decision":"allow"}` and
 * `{"updatedInput":{...}}` must have both applied, and neither may swallow the
 * other.
 *
 * `payload` is accepted so a caller can hand back the payload it gave to
 * `fireHookGroups`; the group result already carries every decision.
 */
export function applyHookGroupResult(group: HookGroupResult, _payload: HookPayload): HookGroupApplication {
  if (!group.fired) return { ok: true };

  const verdict = winningDecision(group.handlers);
  const rewrite = firstRewrite(group.handlers);
  return {
    ok: true,
    ...(verdict !== undefined ? { decision: verdict.decision } : {}),
    ...(rewrite.updatedInput !== undefined ? { updatedInput: rewrite.updatedInput } : {}),
    ...(rewrite.additionalContext !== undefined ? { additionalContext: rewrite.additionalContext } : {}),
    ...(rewrite.systemMessage !== undefined ? { systemMessage: rewrite.systemMessage } : {}),
  };
}

/**
 * The payload field a group's matcher filters on, for `event`.
 *
 * `SessionStart` filters on `startupSource`, which `buildPayload` always sets
 * for that event, so a matcher written as `startup` or `resume` is reachable.
 * It falls back to the empty string only when a caller assembles a
 * `SessionStart` payload by hand and leaves the field out, in which case an
 * exact matcher correctly does not match rather than matching everything.
 */
function matcherValue(event: string, payload: HookPayload): string {
  switch (matcherField(event)) {
    case "toolName":
      return payload.toolName ?? "";
    case "agentType":
      return payload.agentType ?? "";
    case "startupSource":
      return payload.startupSource ?? "";
    case "all":
      return "";
  }
}

/**
 * Fire all hook groups for an event and merge their results.
 *
 * Returns a HookGroupResult per group, in declaration order. The caller decides
 * how to apply them (e.g., deny on first deny, rewrite on first rewrite).
 */
export async function fireHookGroups(
  event: string,
  groups: HookGroup[],
  payload: HookPayload,
  timeouts: HookTimeouts,
  mcpClients: McpClient[],
): Promise<HookGroupResult[]> {
  const results: HookGroupResult[] = [];
  for (const g of groups) {
    const matcher = g.matcher ?? "*";
    const matched = matcherMatches(parseMatcher(g.matcher), matcherValue(event, payload)) && ifFilterApplies(g, payload);
    if (!matched) {
      // A group that does not match never runs its handlers: a `Bash` hook must
      // not execute for a `Read` tool call, and the empty `handlers` list is
      // what tells `decideFromHooks` this group was not in play.
      results.push({ matcher, fired: false, handlers: [] });
      continue;
    }

    const handlers = await Promise.all(
      g.handlers.map(async (handler, index) => {
        const result = await runHookHandler(handler, payload, timeouts, mcpClients);
        return { ...result, index };
      }),
    );

    const groupResult: HookGroupResult = { matcher, fired: true, handlers };
    // Surface the same verdict the chain will reach, so a trace read by
    // `jaa hooks test` never shows an `allow` for a group that is about to be
    // resolved to `deny`.
    const verdict = groupVerdict(groupResult, (BLOCKING_EVENTS as readonly string[]).includes(event));
    if (verdict !== undefined) {
      groupResult.decision = verdict.decision;
      if (verdict.reason !== undefined) groupResult.reason = verdict.reason;
    }
    const rewrite = firstRewrite(handlers);
    if (rewrite.updatedInput !== undefined) groupResult.updatedInput = rewrite.updatedInput;
    if (rewrite.additionalContext !== undefined) groupResult.additionalContext = rewrite.additionalContext;
    if (rewrite.systemMessage !== undefined) groupResult.systemMessage = rewrite.systemMessage;
    results.push(groupResult);
  }
  return results;
}

/**
 * Run every group registered for `event` and produce the decision to apply.
 *
 * Fail-closed, at both levels. Within a group, a handler that crashed or timed
 * out denies on a blocking event however its siblings voted. Across groups, the
 * chain takes the most restrictive verdict on offer, so a group asking for
 * confirmation outranks an earlier group that merely allowed. On a post event
 * the same failure resolves to a passthrough. A hook can therefore only narrow
 * what the operator's permission engine already decided, never silently widen
 * it.
 */
export async function decideFromHooks(
  event: HookEvent,
  groups: HookGroup[],
  payload: HookPayload,
  timeouts: HookTimeouts = DEFAULT_TIMEOUTS,
  mcpClients: McpClient[] = [],
): Promise<HookChainResult> {
  const results = await fireHookGroups(event, groups, payload, timeouts, mcpClients);
  const chain: HookChainResult = { groups: results };
  const blocking = BLOCKING_EVENTS.includes(event);
  // The most restrictive verdict seen so far and the reason that came with it.
  // A deny returns from the loop below, so only allow and ask are ever compared.
  let best: { decision: HookDecision; reason?: string } | undefined;

  for (const group of results) {
    if (!group.fired) continue;
    const applied = applyHookGroupResult(group, payload);
    const verdict = groupVerdict(group, blocking);

    // Rewrites merge in declaration order, independently of the decision above:
    // a group that both blocks and rewrites keeps both, and merging them before
    // the deny short-circuit is what stops a deny from discarding a rewrite.
    if (chain.updatedInput === undefined && applied.updatedInput !== undefined) chain.updatedInput = applied.updatedInput;
    if (chain.additionalContext === undefined && applied.additionalContext !== undefined) {
      chain.additionalContext = applied.additionalContext;
    }
    if (chain.systemMessage === undefined && applied.systemMessage !== undefined) chain.systemMessage = applied.systemMessage;

    if (verdict?.decision === "deny") {
      chain.decision = "deny";
      if (verdict.reason !== undefined) chain.reason = verdict.reason;
      return chain;
    }

    // Same ranking one level up: a later `ask` is not cancelled by an earlier
    // `allow`, because the operator asked to be consulted and an allow is not a
    // decision to consult them.
    if (verdict !== undefined && (best === undefined || outranks(verdict.decision, best.decision))) best = verdict;
  }

  if (best !== undefined) {
    chain.decision = best.decision;
    if (best.reason !== undefined) chain.reason = best.reason;
  }

  return chain;
}
