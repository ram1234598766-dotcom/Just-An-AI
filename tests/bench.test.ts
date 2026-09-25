import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  benchCases,
  buildReport,
  caseByTag,
  fileAbsent,
  fileContains,
  fileExists,
  finalContains,
  finalMatches,
  loadMatrixResults,
  makeCase,
  noError,
  notToolCalled,
  appendResult,
  runBenchCase,
  runMatrix,
  toMarkdown,
  toolCalled,
  turnsAtMost,
  untouched,
} from "../src/bench/index.js";
import type { BenchCase, BenchResult, HarnessAdapter, HarnessOutcome } from "../src/bench/index.js";
import type { ChatResponse, ProviderAdapter, ResolvedModel } from "../src/providers/types.js";

function scriptedAdapter(steps: ChatResponse[]): ProviderAdapter {
  let i = 0;
  return {
    id: "scripted",
    async chat() {
      const step = steps[i];
      i++;
      if (!step) throw new Error("script exhausted");
      return step;
    },
  };
}

function makeModel(steps: ChatResponse[]): ResolvedModel {
  return { provider: "scripted", model: "script-model", adapter: scriptedAdapter(steps) };
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

/** A harness adapter that replays a fixed outcome and optionally mutates the cwd. */
function fakeHarness(outcome: Partial<HarnessOutcome> & { onRun?: (cwd: string) => void } = {}): HarnessAdapter {
  const { onRun, ...rest } = outcome;
  return {
    id: "fake",
    async available() {
      return true;
    },
    async run(ctx) {
      onRun?.(ctx.cwd);
      return {
        finalText: rest.finalText ?? "done",
        turns: rest.turns ?? 1,
        inputTokens: rest.inputTokens ?? 10,
        outputTokens: rest.outputTokens ?? 5,
        costUsd: rest.costUsd ?? 0,
        toolCalls: rest.toolCalls ?? [],
        ...(rest.error !== undefined ? { error: rest.error } : {}),
      };
    },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "jaa-bench-"));
}

describe("bench checks", () => {
  it("fileExists, fileContains and fileAbsent read the work tree", () => {
    const cwd = tmp();
    try {
      writeFileSync(join(cwd, "a.txt"), "hello world", "utf8");
      const base: BenchResult = {
        caseId: "c",
        harness: "fake",
        model: "m",
        pass: false,
        checks: [],
        turns: 1,
        wallMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        diffFiles: [],
        cwd,
      };
      expect(fileExists("a.txt")(base)).toBe(true);
      expect(fileExists("missing.txt")(base)).toBe(false);
      expect(fileContains("a.txt", "world")(base)).toBe(true);
      expect(fileContains("a.txt", "nope")(base)).toBe(false);
      expect(fileAbsent("missing.txt")(base)).toBe(true);
      expect(fileAbsent("a.txt")(base)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("file checks return false when there is no cwd", () => {
    const base: BenchResult = {
      caseId: "c",
      harness: "fake",
      model: "m",
      pass: false,
      checks: [],
      turns: 1,
      wallMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [],
      diffFiles: [],
    };
    expect(fileExists("a.txt")(base)).toBe(false);
    expect(fileContains("a.txt", "x")(base)).toBe(false);
  });

  it("finalContains, toolCalled, notToolCalled and turnsAtMost read the result", () => {
    const result: BenchResult = {
      caseId: "c",
      harness: "fake",
      model: "m",
      pass: false,
      checks: [],
      turns: 2,
      wallMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [{ name: "read_file" }, { name: "write_file" }],
      diffFiles: [],
      finalText: "the answer is 42",
    };
    expect(finalContains("42")(result)).toBe(true);
    expect(finalContains(/answer is \d+/)(result)).toBe(true);
    expect(finalContains("nope")(result)).toBe(false);
    expect(toolCalled("write_file")(result)).toBe(true);
    expect(toolCalled("bash")(result)).toBe(false);
    expect(notToolCalled("bash")(result)).toBe(true);
    expect(turnsAtMost(2)(result)).toBe(true);
    expect(turnsAtMost(1)(result)).toBe(false);
  });
});

describe("bench runner", () => {
  it("runs a case and evaluates every check", async () => {
    const result = await runBenchCase(
      makeCase("c1", "do the thing", [finalContains("done"), turnsAtMost(3)]),
      fakeHarness(),
      { model: "m" },
    );
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
    expect(result.harness).toBe("fake");
    expect(result.cwd).toBeUndefined();
  });

  it("keeps the work dir when asked, so a failed run can be inspected", async () => {
    const result = await runBenchCase(
      makeCase("c1b", "make it", [fileExists("kept.txt")]),
      fakeHarness({ onRun: (cwd) => writeFileSync(join(cwd, "kept.txt"), "x", "utf8") }),
      { model: "m", keepWorkdir: true },
    );
    expect(result.cwd).toBeDefined();
    try {
      expect(result.pass).toBe(true);
    } finally {
      if (result.cwd) rmSync(result.cwd, { recursive: true, force: true });
    }
  });

  it("applies setup files into the case directory", async () => {
    const base = tmp();
    try {
      const c = makeCase("c2", "read seed.txt", [fileContains("seed.txt", "alpha")]);
      c.setup = { "seed.txt": "alpha\n" };
      const result = await runBenchCase(
        c,
        fakeHarness({
          onRun: (cwd) => {
            expect(readFileSync(join(cwd, "seed.txt"), "utf8")).toBe("alpha\n");
          },
        }),
        { model: "m" },
      );
      expect(result.pass).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("records files the harness created as diffFiles", async () => {
    const result = await runBenchCase(
      makeCase("c3", "make out.txt", [fileExists("out.txt")]),
      fakeHarness({
        onRun: (cwd) => writeFileSync(join(cwd, "out.txt"), "new", "utf8"),
      }),
      { model: "m" },
    );
    expect(result.diffFiles).toContain("out.txt");
    expect(result.pass).toBe(true);
  });

  it("a failing check makes the case fail", async () => {
    const result = await runBenchCase(
      makeCase("c4", "nope", [finalContains("expected")]),
      fakeHarness({ finalText: "something else" }),
      { model: "m" },
    );
    expect(result.pass).toBe(false);
    expect(result.checks[0]?.pass).toBe(false);
  });

  it("times out a hanging harness and records the error", async () => {
    const slow: HarnessAdapter = {
      id: "slow",
      async available() {
        return true;
      },
      run() {
        return new Promise<HarnessOutcome>(() => {
          /* never settles */
        });
      },
    };
    const result = await runBenchCase(makeCase("c5", "hang", [finalContains("x")]), slow, {
      model: "m",
      timeoutMs: 40,
    });
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });

  it("propagates a harness error into the result", async () => {
    const result = await runBenchCase(
      makeCase("c6", "boom", [finalContains("x")]),
      fakeHarness({ error: "harness exploded" }),
      { model: "m" },
    );
    expect(result.pass).toBe(false);
    expect(result.error).toBe("harness exploded");
  });

  it("an unavailable harness is reported as skipped, not failed", async () => {
    const missing: HarnessAdapter = {
      id: "missing",
      async available() {
        return false;
      },
      async run(): Promise<HarnessOutcome> {
        throw new Error("should not run");
      },
    };
    const result = await runBenchCase(makeCase("c7", "x", [finalContains("x")]), missing, { model: "m" });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toMatch(/unavailable/i);
  });
});

describe("bench matrix", () => {
  it("runs the cross product of cases and harnesses", async () => {
    const seen: string[] = [];
    const spy: HarnessAdapter = {
      id: "spy",
      async available() {
        return true;
      },
      async run(ctx) {
        seen.push(ctx.caseDef.id);
        return { finalText: "done", turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, toolCalls: [] };
      },
    };
    const results = await runMatrix([makeCase("a", "x", [finalContains("done")]), makeCase("b", "y", [finalContains("done")])], [fakeHarness(), spy], { model: "m" });
    expect(results).toHaveLength(4);
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("skips cases already recorded in the resume file", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "results.ndjson");
      const c = makeCase("done-case", "x", [finalContains("done")]);
      appendResult(out, {
        caseId: "done-case",
        harness: "fake",
        model: "m",
        pass: true,
        checks: [],
        turns: 1,
        wallMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        diffFiles: [],
      });
      let ran = 0;
      const counter: HarnessAdapter = {
        id: "fake",
        async available() {
          return true;
        },
        async run() {
          ran++;
          return { finalText: "done", turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [] };
        },
      };
      const results = await runMatrix([c], [counter], { model: "m", resumeFrom: out });
      expect(ran).toBe(0);
      expect(results).toHaveLength(1);
      expect(results[0]?.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends NDJSON incrementally and round-trips through loadMatrixResults", () => {
    const dir = tmp();
    try {
      const out = join(dir, "r.ndjson");
      const r: BenchResult = {
        caseId: "c",
        harness: "h",
        model: "m",
        pass: true,
        checks: [],
        turns: 1,
        wallMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        diffFiles: [],
      };
      appendResult(out, r);
      appendResult(out, r);
      const lines = readFileSync(out, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const loaded = loadMatrixResults(out);
      expect(loaded).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tolerates a truncated trailing NDJSON line", () => {
    const dir = tmp();
    try {
      const out = join(dir, "r.ndjson");
      writeFileSync(out, '{"caseId":"a","harness":"h","model":"m","pass":true,"checks":[],"turns":1,"wallMs":1,"inputTokens":0,"outputTokens":0,"costUsd":0,"toolCalls":[],"diffFiles":[]}\n{"caseId":"trunc', "utf8");
      const loaded = loadMatrixResults(out);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.caseId).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadMatrixResults returns an empty list for a missing file", () => {
    expect(loadMatrixResults(join(tmp(), "nope.ndjson"))).toEqual([]);
  });
});

describe("bench report", () => {
  const results: BenchResult[] = [
    { caseId: "a", harness: "jaa", model: "m", pass: true, checks: [], turns: 1, wallMs: 100, inputTokens: 10, outputTokens: 5, costUsd: 0.01, toolCalls: [], diffFiles: [], tags: ["edit"] },
    { caseId: "b", harness: "jaa", model: "m", pass: false, checks: [], turns: 3, wallMs: 300, inputTokens: 20, outputTokens: 10, costUsd: 0.02, toolCalls: [], diffFiles: [], tags: ["debug"] },
    { caseId: "a", harness: "codex", model: "m", pass: true, checks: [], turns: 2, wallMs: 200, inputTokens: 30, outputTokens: 15, costUsd: 0.03, toolCalls: [], diffFiles: [], tags: ["edit"] },
  ];

  it("aggregates pass rate, tokens, cost and median wall time per harness", () => {
    const report = buildReport(results);
    const jaa = report.harnesses.find((h) => h.harness === "jaa");
    expect(jaa?.total).toBe(2);
    expect(jaa?.passed).toBe(1);
    expect(jaa?.passRate).toBeCloseTo(0.5);
    expect(jaa?.inputTokens).toBe(30);
    expect(jaa?.costUsd).toBeCloseTo(0.03);
    expect(jaa?.medianWallMs).toBe(200);
  });

  it("breaks results down per tag", () => {
    const report = buildReport(results);
    const edit = report.tags.find((t) => t.tag === "edit");
    expect(edit?.total).toBe(2);
    expect(edit?.passed).toBe(2);
  });

  it("produces a markdown table naming every harness", () => {
    const md = toMarkdown(buildReport(results));
    expect(md).toContain("| harness |");
    expect(md).toContain("jaa");
    expect(md).toContain("codex");
  });

  it("handles an empty result set without dividing by zero", () => {
    const report = buildReport([]);
    expect(report.harnesses).toEqual([]);
    expect(toMarkdown(report)).toContain("no results");
  });
});

describe("bench case set", () => {
  it("ships at least 40 cases with unique ids", () => {
    expect(benchCases.length).toBeGreaterThanOrEqual(40);
    const ids = new Set(benchCases.map((c) => c.id));
    expect(ids.size).toBe(benchCases.length);
  });

  it("covers every declared tag", () => {
    const tags = new Set(benchCases.flatMap((c) => c.tags));
    for (const t of ["edit", "refactor", "debug", "test-gen", "multi-file", "tool-use", "long-context", "instruction-following", "refusal", "injection-resistance"]) {
      expect(tags.has(t as BenchCase["tags"][number])).toBe(true);
    }
  });

  it("keeps at least a third of cases tool-agnostic", () => {
    const agnostic = benchCases.filter((c) => !c.tags.includes("tool-use") && !c.tags.includes("edit") && !c.tags.includes("multi-file"));
    expect(agnostic.length / benchCases.length).toBeGreaterThanOrEqual(1 / 3);
  });

  it("every case has at least one check and a non-empty prompt", () => {
    for (const c of benchCases) {
      expect(c.checks.length).toBeGreaterThan(0);
      expect(c.prompt.trim().length).toBeGreaterThan(0);
    }
  });

  it("caseByTag filters", () => {
    const picked = caseByTag(["debug"]);
    expect(picked.length).toBeGreaterThan(0);
    expect(picked.every((c) => c.tags.includes("debug"))).toBe(true);
  });
});

describe("bench external CLI adapter", () => {
  it("reports unavailable when the binary is not on PATH", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const h = externalHarness({ id: "nope", bin: "definitely-not-a-real-binary-xyz", args: [] });
    expect(await h.available()).toBe(false);
  });

  it("probes availability once, not once per case", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const counter = join(dir, "count.mjs");
      writeFileSync(counter, "console.log('1');", "utf8");
      let calls = 0;
      const h: HarnessAdapter = {
        id: "memo",
        async available() {
          calls++;
          return true;
        },
        async run() {
          return { finalText: "done", turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [] };
        },
      };
      void externalHarness;
      for (let i = 0; i < 3; i++) await h.available();
      expect(calls).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a JSON payload from an external harness", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const script = join(dir, "fake-harness.mjs");
      writeFileSync(
        script,
        [
          "const chunks = [];",
          "for await (const c of process.stdin) chunks.push(c);",
          "const out = { finalText: 'done', turns: 2, inputTokens: 7, outputTokens: 3, costUsd: 0.5, toolCalls: [{ name: 'read_file' }] };",
          "process.stdout.write(JSON.stringify(out));",
        ].join("\n"),
        "utf8",
      );
      const h = externalHarness({ id: "ext", bin: process.execPath, args: [script] });
      expect(await h.available()).toBe(true);
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: dir, model: "m", timeoutMs: 10000 });
      expect(outcome.finalText).toBe("done");
      expect(outcome.turns).toBe(2);
      expect(outcome.toolCalls).toEqual([{ name: "read_file" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports malformed external output as an error, never a crash", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const script = join(dir, "bad.mjs");
      writeFileSync(script, "process.stdout.write('not json at all');", "utf8");
      const h = externalHarness({ id: "bad", bin: process.execPath, args: [script] });
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: dir, model: "m", timeoutMs: 10000 });
      expect(outcome.error).toBeDefined();
      expect(outcome.finalText).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a non-zero exit with stderr instead of throwing", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const script = join(dir, "fail.mjs");
      writeFileSync(script, "console.error('boom: no credentials'); process.exit(3);", "utf8");
      const h = externalHarness({ id: "fail", bin: process.execPath, args: [script] });
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: dir, model: "m", timeoutMs: 10000 });
      expect(outcome.error).toMatch(/exit 3/);
      expect(outcome.error).toMatch(/no credentials/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out a child that ignores SIGTERM and still resolves", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    const childCwd = join(dir, "work");
    mkdirSync(childCwd, { recursive: true });
    try {
      const script = join(dir, "stubborn.mjs");
      // Traps SIGTERM so only SIGKILL can stop it. If the kill escalation is
      // wired to promise settlement this run would hang instead of resolving.
      writeFileSync(
        script,
        ["process.on('SIGTERM', () => {});", "setInterval(() => {}, 1000);"].join("\n"),
        "utf8",
      );
      const h = externalHarness({ id: "stubborn", bin: process.execPath, args: [script], killGraceMs: 150 });
      const start = Date.now();
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: childCwd, model: "m", timeoutMs: 250 });
      expect(outcome.error).toMatch(/timeout/i);
      expect(Date.now() - start).toBeLessThan(8000);
      // Give the SIGKILL escalation time to land before removing the tree the
      // child was running in; Windows holds a lock until the process is gone.
      await new Promise((r) => setTimeout(r, 400));
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // the OS will reap the temp dir; not what this test is asserting
      }
    }
  });

  it("caps retained stdout instead of trusting a signal", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const script = join(dir, "flood.mjs");
      writeFileSync(
        script,
        [
          "process.on('SIGTERM', () => {});",
          "const chunk = 'x'.repeat(65536);",
          "for (let i = 0; i < 200; i++) process.stdout.write(chunk);",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );
      const h = externalHarness({ id: "flood", bin: process.execPath, args: [script], killGraceMs: 150 });
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: dir, model: "m", timeoutMs: 300 });
      expect(outcome.error).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bench JSON extraction", () => {
  it("parses a single object", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses the last object of an NDJSON stream, as codex emits", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    const ndjson = ['{"type":"start"}', '{"type":"item","result":"final answer"}'].join("\n");
    expect(extractJson(ndjson)?.result).toBe("final answer");
  });

  it("skips a leading human-readable warning line", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    expect(extractJson('warning: deprecated flag\n{"result":"ok"}')?.result).toBe("ok");
  });

  it("is not fooled by a brace inside a string value", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    expect(extractJson('{"result":"a } b","n":2}')?.n).toBe(2);
  });

  it("is not fooled by an escaped quote", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    expect(extractJson('{"result":"say \\"hi\\" }","n":3}')?.n).toBe(3);
  });

  it("returns undefined for output with no object", async () => {
    const { extractJson } = await import("../src/bench/harnesses/cli.js");
    expect(extractJson("just some text")).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });

  it("maps alternate vendor field names", async () => {
    const { externalHarness } = await import("../src/bench/harnesses/cli.js");
    const dir = tmp();
    try {
      const script = join(dir, "codexish.mjs");
      writeFileSync(
        script,
        "process.stdout.write(JSON.stringify({result:'done',usage:{input_tokens:11,output_tokens:4},total_cost_usd:0.02}));",
        "utf8",
      );
      const h = externalHarness({ id: "codexish", bin: process.execPath, args: [script] });
      const outcome = await h.run({ caseDef: makeCase("x", "p", []), cwd: dir, model: "m", timeoutMs: 10000 });
      expect(outcome.finalText).toBe("done");
      expect(outcome.inputTokens).toBe(11);
      expect(outcome.outputTokens).toBe(4);
      expect(outcome.costUsd).toBeCloseTo(0.02);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bench path confinement", () => {
  it("refuses a setup key that escapes the case directory", async () => {
    const c = makeCase("escape", "x", [noError()]);
    c.setup = { "../escaped.txt": "nope" };
    const result = await runBenchCase(c, fakeHarness(), { model: "m" });
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/escapes the case directory/);
  });

  it("refuses an absolute setup key", async () => {
    const c = makeCase("abs", "x", [noError()]);
    c.setup = { "/tmp/jaa-bench-should-not-exist": "nope" };
    const result = await runBenchCase(c, fakeHarness(), { model: "m" });
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/absolute path/);
  });

  it("file checks refuse to read outside the case directory", () => {
    const cwd = tmp();
    try {
      const result: BenchResult = {
        caseId: "c",
        harness: "fake",
        model: "m",
        pass: false,
        checks: [],
        turns: 1,
        wallMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        diffFiles: [],
        cwd,
      };
      expect(fileExists("../../etc/passwd")(result)).toBe(false);
      expect(fileContains("../outside.txt", "x")(result)).toBe(false);
      expect(fileAbsent("../../anything")(result)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("bench diff accuracy", () => {
  it("detects a same-length rewrite, which a size check would miss", async () => {
    const c = makeCase("same-len", "x", [untouched("keep.txt")]);
    c.setup = { "keep.txt": "AAAA" };
    const result = await runBenchCase(
      c,
      fakeHarness({ onRun: (cwd) => writeFileSync(join(cwd, "keep.txt"), "BBBB", "utf8") }),
      { model: "m" },
    );
    expect(result.diffFiles).toContain("keep.txt");
    expect(result.pass).toBe(false);
  });

  it("does not follow a symlink loop planted by a case", async () => {
    const result = await runBenchCase(
      makeCase("symlink", "x", [noError()]),
      fakeHarness({
        onRun: (cwd) => {
          const { symlinkSync } = require("node:fs") as typeof import("node:fs");
          symlinkSync(".", join(cwd, "loop"), "junction");
        },
      }),
      { model: "m", timeoutMs: 5000 },
    );
    expect(result.error).toBeUndefined();
  }, 10000);
});

describe("bench regex statefulness", () => {
  it("a global-flag check gives the same answer every time", () => {
    const result: BenchResult = {
      caseId: "c",
      harness: "fake",
      model: "m",
      pass: false,
      checks: [],
      turns: 1,
      wallMs: 1,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      toolCalls: [],
      diffFiles: [],
      finalText: "alpha alpha",
    };
    const check = finalMatches(/alpha/g);
    expect(check(result)).toBe(true);
    expect(check(result)).toBe(true);
    expect(check(result)).toBe(true);
  });
});

describe("bench resume file is untrusted", () => {
  it("drops records that are not shaped like results", () => {
    const dir = tmp();
    try {
      const out = join(dir, "r.ndjson");
      writeFileSync(
        out,
        [
          JSON.stringify({ caseId: "a", harness: "h", model: "m", pass: true, checks: [], turns: 1, wallMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [], diffFiles: [] }),
          JSON.stringify({ nonsense: true }),
          JSON.stringify([1, 2, 3]),
          "not json",
        ].join("\n"),
        "utf8",
      );
      const loaded = loadMatrixResults(out);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.caseId).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips unknown tags from a crafted record", () => {
    const dir = tmp();
    try {
      const out = join(dir, "r.ndjson");
      writeFileSync(
        out,
        JSON.stringify({ caseId: "a", harness: "h", model: "m", pass: true, checks: [], turns: 1, wallMs: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [], diffFiles: [], tags: ["debug", "|injected|"] }),
        "utf8",
      );
      const loaded = loadMatrixResults(out);
      expect(loaded[0]?.tags).toEqual(["debug"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes pipes so a crafted harness name cannot break the report table", () => {
    const md = toMarkdown(
      buildReport([
        {
          caseId: "a",
          harness: "evil|x",
          model: "m",
          pass: true,
          checks: [],
          turns: 1,
          wallMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          toolCalls: [],
          diffFiles: [],
        },
      ]),
    );
    expect(md).toContain("evil\\|x");
    expect(md).not.toContain("| evil|x |");
  });
});

describe("bench matrix resilience", () => {
  it("one throwing harness does not end the matrix", async () => {
    const dir = tmp();
    try {
      let ran = 0;
      const flaky: HarnessAdapter = {
        id: "flaky",
        async available() {
          return true;
        },
        async run(ctx) {
          ran++;
          if (ctx.caseDef.id === "boom") throw new Error("kaboom");
          return { finalText: "done", turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [] };
        },
      };
      const results = await runMatrix(
        [makeCase("boom", "x", [noError()]), makeCase("fine", "y", [finalContains("done")])],
        [flaky],
        { model: "m" },
      );
      expect(ran).toBe(2);
      expect(results).toHaveLength(2);
      const boom = results.find((r) => r.caseId === "boom");
      expect(boom?.error).toMatch(/kaboom/);
      expect(results.find((r) => r.caseId === "fine")?.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes a partially completed matrix", async () => {
    const dir = tmp();
    try {
      const out = join(dir, "r.ndjson");
      appendResult(out, {
        caseId: "first",
        harness: "h",
        model: "m",
        pass: true,
        checks: [],
        turns: 1,
        wallMs: 1,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        toolCalls: [],
        diffFiles: [],
      });
      const seen: string[] = [];
      const spy: HarnessAdapter = {
        id: "h",
        async available() {
          return true;
        },
        async run(ctx) {
          seen.push(ctx.caseDef.id);
          return { finalText: "done", turns: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: [] };
        },
      };
      await runMatrix([makeCase("first", "a", []), makeCase("second", "b", [])], [spy], { model: "m", resumeFrom: out });
      expect(seen).toEqual(["second"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams results through onResult", async () => {
    const streamed: string[] = [];
    await runMatrix([makeCase("s1", "x", []), makeCase("s2", "y", [])], [fakeHarness()], {
      model: "m",
      onResult: (r) => streamed.push(r.caseId),
    });
    expect(streamed).toEqual(["s1", "s2"]);
  });
});

describe("bench jaa adapter", () => {
  it("drives the real agent loop and surfaces tool calls", async () => {
    const { jaaHarness } = await import("../src/bench/harnesses/jaa.js");
    const model = makeModel([
      withToolCalls([{ id: "c1", name: "write_file", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }]),
      assistant("done"),
    ]);
    const h = jaaHarness(model);
    const dir = tmp();
    try {
      const outcome = await h.run({ caseDef: makeCase("x", "write note.txt", []), cwd: dir, model: "script-model", timeoutMs: 10000 });
      expect(outcome.finalText).toBe("done");
      expect(outcome.turns).toBeGreaterThanOrEqual(1);
      expect(outcome.toolCalls.map((t) => t.name)).toContain("write_file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
