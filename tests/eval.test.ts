import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { runEvalTask, summarize } from "../src/eval/runner.js";
import { seedTasks, task, contains, toolCalled, fileExists, stopReasonIs, passesChecks } from "../src/eval/index.js";
import type { ChatResponse, ProviderAdapter, ResolvedModel } from "../src/providers/types.js";

function scriptedAdapter(steps: ChatResponse[]): ProviderAdapter & { requested: any[] } {
  let i = 0;
  const requested: any[] = [];
  return {
    id: "scripted",
    async chat(req) {
      requested.push(req);
      const step = steps[i];
      i++;
      if (!step) throw new Error("script exhausted");
      return step;
    },
    requested,
  };
}

function makeModel(steps: ChatResponse[]): ResolvedModel & { adapter: ProviderAdapter & { requested: any[] } } {
  const adapter = scriptedAdapter(steps);
  return { provider: "scripted", model: "script-model", adapter };
}

const assistant = (content: string): ChatResponse => ({
  message: { role: "assistant", content },
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "script-model",
  provider: "scripted",
});

const withToolCalls = (calls: { id: string; name: string; arguments: string }[], content = ""): ChatResponse => ({
  message: { role: "assistant", content, toolCalls: calls },
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "script-model",
  provider: "scripted",
});

describe("eval harness", () => {
  it("runs a passing task and reports pass@1", async () => {
    const model = makeModel([assistant("OK")]);
    const run = await runEvalTask(
      task("t1", "Reply with exactly the word OK.", [passesChecks(stopReasonIs("completed"), contains("OK"))]),
      { model, executeTool: async () => "" },
    );
    expect(run.pass).toBe(true);
    expect(run.retries).toBe(0);
    expect(run.turns).toBe(1);
  });

  it("retries failing tasks up to the configured count", async () => {
    const model = makeModel([assistant("nope"), assistant("OK")]);
    const run = await runEvalTask(
      task("t2", "Say OK", [contains("OK")]),
      { model, executeTool: async () => "", retries: 1 },
    );
    expect(run.pass).toBe(true);
    expect(run.retries).toBe(1);
  });

  it("seed tasks include write-file and list-files", () => {
    const ids = seedTasks.map((t) => t.id);
    expect(ids).toContain("echo-ok");
    expect(ids).toContain("write-file");
    expect(ids).toContain("list-files");
    expect(ids).toContain("bash-gated");
  });

  it("summarize computes pass@1 and pass@N", () => {
    const runs = [
      { taskId: "a", prompt: "", pass: true, checks: [], stopReason: "completed" as const, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 0, retries: 0 },
      { taskId: "b", prompt: "", pass: false, checks: [], stopReason: "completed" as const, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 0, retries: 0 },
      { taskId: "c", prompt: "", pass: true, checks: [], stopReason: "completed" as const, turns: 1, inputTokens: 0, outputTokens: 0, durationMs: 0, retries: 1 },
    ] as any[];
    const summary = summarize(runs);
    expect(summary.total).toBe(3);
    expect(summary.passAt1).toBe(1);
    expect(summary.passAtN).toBe(2);
  });

  it("evaluates toolCalled and fileExists checks", async () => {
    const model = makeModel([
      withToolCalls([{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hello world" }) }]),
      assistant("done"),
    ]);
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const cwd = mkdtempSync(join(tmpdir(), "jaa-eval-"));
    const { writeFileSync } = await import("node:fs");
    const run = await runEvalTask(
      task("t3", "write hello.txt", [
        passesChecks(toolCalled("write_file"), fileExists("hello.txt"), contains("done")),
      ]),
      {
        model,
        cwd,
        executeTool: async (call) => {
          if (call.name === "write_file") {
            const args = JSON.parse(call.arguments) as { path: string; content: string };
            writeFileSync(join(cwd, args.path), args.content, "utf8");
            return "ok";
          }
          return "ok";
        },
      },
    );
    expect(run.pass).toBe(true);
  });
});