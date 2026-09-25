export { BENCH_TAGS, DEFAULT_CASE_TIMEOUT_MS } from "./types.js";
export type {
  BenchCase,
  BenchCheck,
  BenchReport,
  BenchResult,
  BenchRunContext,
  BenchTag,
  HarnessAdapter,
  HarnessOutcome,
  HarnessSummary,
  TagSummary,
} from "./types.js";
export {
  all,
  any,
  caseOf,
  errored,
  fileAbsent,
  fileContains,
  fileExists,
  fileLineCountAtLeast,
  finalContains,
  finalLacks,
  finalMatches,
  noError,
  notToolCalled,
  toolCalled,
  toolCalledAtLeast,
  touched,
  turnsAtLeast,
  turnsAtMost,
  untouched,
} from "./checks.js";
export { benchCases, caseByTag } from "./cases.js";
export { runBenchCase } from "./runner.js";
export { appendResult, loadMatrixResults, resultKey, runMatrix } from "./matrix.js";
export { buildReport, toMarkdown } from "./report.js";
export { externalHarness, knownExternalHarnesses } from "./harnesses/cli.js";
export { jaaHarness } from "./harnesses/jaa.js";

import { caseOf } from "./checks.js";
import type { BenchCase, BenchCheck, BenchTag } from "./types.js";

/** Convenience constructor mirroring `eval`'s `task()` helper. */
export function makeCase(
  id: string,
  prompt: string,
  checks: BenchCheck[],
  tags: BenchTag[] = ["tool-use"],
): BenchCase {
  return caseOf(id, prompt, tags, checks);
}
