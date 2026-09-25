import { DEFAULT_SYSTEM_PROMPT, runAgentLoop } from "../../agent/loop.js";
import { createDefaultRegistry } from "../../tools/index.js";
import type { ToolContext } from "../../tools/types.js";
import type { ResolvedModel } from "../../providers/types.js";
import type { BenchRunContext, HarnessAdapter, HarnessOutcome } from "../types.js";

export interface JaaHarnessOptions {
  allowBash?: boolean;
  maxTurns?: number;
  tokenBudget?: number;
}

export function jaaHarness(model: ResolvedModel, options: JaaHarnessOptions = {}): HarnessAdapter {
  return {
    id: "jaa",
    async available() {
      return true;
    },
    async run(ctx: BenchRunContext): Promise<HarnessOutcome> {
      const registry = createDefaultRegistry();
      const toolContext: ToolContext = {
        root: ctx.cwd,
        cwd: ctx.cwd,
        allowBash: options.allowBash === true,
      };

      // Use the same system prompt production `jaa ask` uses. A benchmark that
      // measures a different agent than the one that ships measures nothing.
      const messages = [
        { role: "system" as const, content: DEFAULT_SYSTEM_PROMPT },
        { role: "user" as const, content: ctx.caseDef.prompt },
      ];

      const loopOptions: Parameters<typeof runAgentLoop>[0] = {
        model,
        messages,
        tools: registry.list(),
        executeTool: (call) => registry.execute(call.name, call.arguments, toolContext),
      };
      const maxTurns = ctx.caseDef.maxTurns ?? options.maxTurns;
      if (maxTurns !== undefined) loopOptions.maxTurns = maxTurns;
      const tokenBudget = ctx.caseDef.tokenBudget ?? options.tokenBudget;
      if (tokenBudget !== undefined) loopOptions.tokenBudget = tokenBudget;

      const result = await runAgentLoop(loopOptions);

      const toolCalls: { name: string }[] = [];
      let finalText = "";
      for (const m of result.messages) {
        if (m.role !== "assistant") continue;
        // Unconditional: a later empty assistant turn must clear the text
        // rather than leave a stale pre-tool-call preamble as the answer.
        finalText = m.content;
        for (const c of m.toolCalls ?? []) toolCalls.push({ name: c.name });
      }

      return {
        finalText,
        turns: result.turns,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        // Providers report tokens but not USD; pricing is per-model and would
        // be a guess, so it stays 0 rather than inventing a number.
        costUsd: 0,
        toolCalls,
      };
    },
  };
}
