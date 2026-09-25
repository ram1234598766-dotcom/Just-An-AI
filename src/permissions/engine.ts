import {
  defaultRules,
  describeRule,
  isKnownTool,
  isReadOnlyTool,
  NEVER_IMPLICITLY_ALLOWED,
  ruleMatches,
  ruleSpecificity,
} from "./rules.js";
import type { GateOptions, PermissionMode, PermissionOutcome, PermissionRequest, Rule } from "./types.js";

export interface Engine {
  evaluate(request: PermissionRequest): PermissionOutcome;
}

/**
 * Evaluate a request against the rule set.
 *
 * **Deny is absolute.** If any matching rule denies, the call is denied, no
 * matter how specific an allowing rule is. This matches Claude Code's
 * `permissions.deny` semantics and is the only ordering that cannot be
 * defeated by planting a broad allow alongside a narrow deny. Among the
 * remaining non-deny rules the most specific wins.
 */
export function createEngine(rules: Rule[]): Engine {
  return {
    evaluate(request) {
      let best: Rule | undefined;
      let bestScore = -1;
      let deny: Rule | undefined;
      let denyScore = -1;

      for (const r of rules) {
        if (!ruleMatches(r, request)) continue;
        const score = ruleSpecificity(r);
        if (r.decision === "deny") {
          if (score > denyScore) {
            deny = r;
            denyScore = score;
          }
          continue;
        }
        if (score > bestScore) {
          best = r;
          bestScore = score;
        }
      }

      if (deny) {
        return {
          decision: "deny",
          reason: `${describeRequest(request)} denied: ${describeRule(deny)}`,
          rule: deny,
          specificity: denyScore,
        };
      }
      if (!best) {
        return {
          decision: "ask",
          reason: `no rule matched ${describeRequest(request)}; the mode default applies`,
          specificity: -1,
        };
      }
      return {
        decision: best.decision,
        reason: `${describeRequest(request)} matched: ${describeRule(best)}`,
        rule: best,
        specificity: bestScore,
      };
    },
  };
}

function describeRequest(request: PermissionRequest): string {
  const details: string[] = [`tool ${request.tool}`];
  const command = typeof request.args.command === "string" ? request.args.command : undefined;
  const path = typeof request.args.path === "string" ? request.args.path : undefined;
  if (command !== undefined) details.push(`command ${JSON.stringify(command)}`);
  if (path !== undefined) details.push(`path ${JSON.stringify(path)}`);
  return details.join(" ");
}

/**
 * Apply the mode's baseline on top of an explicit rule outcome.
 *
 * An explicit `allow` or `deny` from any rule is final: modes only decide what
 * happens to an `ask`.
 *
 * Three hard rules, all fail-closed:
 * - A tool in `NEVER_IMPLICITLY_ALLOWED` is never allowed by a mode. `bash` runs
 *   an arbitrary agent-supplied command and `git_diff` can execute a
 *   repository-local diff driver, so both need an explicit rule. An explicit
 *   operator `allow` DOES win here, because `defaultRules` emits no competing
 *   rule for them.
 * - A tool jaa does not itself register (anything an MCP server advertises) is
 *   never implicitly allowed either. It gets no mode baseline, because jaa
 *   cannot know what such a tool does, and `confinePath` does not protect it.
 * - `tool` is required, not optional. An optional parameter would let a future
 *   caller skip the checks above by omitting it.
 */
export function resolveDecision(
  outcome: Pick<PermissionOutcome, "decision">,
  mode: PermissionMode,
  readOnly: boolean,
  tool: string,
): "allow" | "deny" | "ask" {
  if (outcome.decision === "allow") return "allow";
  if (outcome.decision === "deny") return "deny";
  const name = tool.toLowerCase();
  if (NEVER_IMPLICITLY_ALLOWED.includes(name)) return "ask";
  if (!isKnownTool(name)) return "ask";
  if (mode === "suggest") return "ask";
  if (readOnly) return "allow";
  if (mode === "auto-edit") return "ask";
  return "allow";
}

export interface GateDeps {
  inner: (call: { name: string; arguments: string; id?: string }) => Promise<string>;
  engine: Engine;
  mode: PermissionMode;
  options: GateOptions;
}

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed argument string is the tool's problem to report, not the
    // gate's. Treat it as "no facts to match on" and keep the least specific
    // applicable rule.
  }
  return {};
}

/**
 * Wrap a tool executor so every call passes the permission engine first.
 *
 * A denial is returned as a result string rather than thrown, so the agent
 * loop can recover and the model can try something else.
 */
export function createPermissionGate(
  inner: (call: { name: string; arguments: string; id?: string }) => Promise<string>,
  engine: Engine,
  mode: PermissionMode,
  options: GateOptions = { interactive: false, cwd: process.cwd(), root: process.cwd() },
): (call: { name: string; arguments: string; id?: string }) => Promise<string> {
  const grants = options.grants;
  return async (call) => {
    const request: PermissionRequest = {
      tool: call.name,
      args: parseArgs(call.arguments),
      cwd: options.cwd,
      root: options.root,
    };

    // A session grant is an exact-match operator decision made earlier in this
    // same session for this same call, so it short-circuits everything.
    if (grants?.has(request)) return inner(call);

    const outcome = engine.evaluate(request);
    const decision = resolveDecision(outcome, mode, isReadOnlyTool(call.name), call.name);

    if (decision === "allow") return inner(call);

    if (decision === "deny") {
      return `permission denied: ${outcome.reason}`;
    }

    // decision === "ask"
    if (!options.interactive) {
      return `permission denied: ${outcome.reason}. Refusing to prompt because this is a non-interactive session; re-run interactively or add an explicit rule.`;
    }
    if (!options.prompt) {
      return `permission denied: ${outcome.reason}. No prompter is configured for this session.`;
    }
    const answer = await options.prompt(request, outcome);
    if (answer === "allow") return inner(call);
    if (answer === "defer") return `permission deferred: ${outcome.reason}`;
    return `permission denied by user: ${outcome.reason}`;
  };
}

export { defaultRules };

/** Turn a validated settings rule (string shorthand or object) into a Rule. */
export function ruleFromSetting(
  input: string | { tool?: string; command?: string; path?: string },
  decision: "allow" | "deny",
  source: Rule["source"] = "settings",
): Rule {
  if (typeof input === "string") {
    return { decision, tool: input, source };
  }
  return {
    decision,
    source,
    ...(input.tool !== undefined ? { tool: input.tool } : {}),
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
  };
}
