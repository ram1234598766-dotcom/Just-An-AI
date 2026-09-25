import { BENCH_TAGS } from "./types.js";
import type { BenchReport, BenchResult, BenchTag, HarnessSummary, TagSummary } from "./types.js";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((lo ?? 0) + (hi ?? 0)) / 2;
}

function rate(passed: number, total: number): number {
  return total === 0 ? 0 : passed / total;
}

export function buildReport(results: BenchResult[], now = new Date()): BenchReport {
  const byHarness = new Map<string, BenchResult[]>();
  for (const r of results) {
    const list = byHarness.get(r.harness) ?? [];
    list.push(r);
    byHarness.set(r.harness, list);
  }

  const harnesses: HarnessSummary[] = [...byHarness.entries()]
    .map(([harness, rs]) => {
      const scored = rs.filter((r) => r.skipped !== true);
      const passed = scored.filter((r) => r.pass).length;
      return {
        harness,
        model: rs[0]?.model ?? "",
        total: scored.length,
        passed,
        skipped: rs.length - scored.length,
        passRate: rate(passed, scored.length),
        medianWallMs: median(scored.map((r) => r.wallMs)),
        medianTurns: median(scored.map((r) => r.turns)),
        inputTokens: scored.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: scored.reduce((s, r) => s + r.outputTokens, 0),
        costUsd: scored.reduce((s, r) => s + r.costUsd, 0),
      };
    })
    .sort((a, b) => b.passRate - a.passRate || a.harness.localeCompare(b.harness));

  const byTag = new Map<BenchTag, BenchResult[]>();
  for (const r of results) {
    if (r.skipped === true) continue;
    for (const tag of r.tags ?? []) {
      const list = byTag.get(tag) ?? [];
      list.push(r);
      byTag.set(tag, list);
    }
  }

  const tags: TagSummary[] = [...byTag.entries()]
    .map(([tag, rs]) => {
      const passed = rs.filter((r) => r.pass).length;
      return { tag, total: rs.length, passed, passRate: rate(passed, rs.length) };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag));

  const scored = results.filter((r) => r.skipped !== true);
  const passed = scored.filter((r) => r.pass).length;

  return {
    generatedAt: now.toISOString(),
    harnesses,
    tags,
    totals: {
      cases: new Set(results.map((r) => r.caseId)).size,
      results: results.length,
      passed,
      skipped: results.length - scored.length,
      wallMs: scored.reduce((s, r) => s + r.wallMs, 0),
      costUsd: scored.reduce((s, r) => s + r.costUsd, 0),
    },
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Escape a value so a hostile resume file cannot break out of a table cell. */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").slice(0, 120);
}

export function toMarkdown(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("# jaa benchmark report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push("");

  if (report.harnesses.length === 0) {
    lines.push("no results recorded.");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Harnesses");
  lines.push("");
  lines.push("| harness | model | pass | pass rate | median wall ms | median turns | in tok | out tok | cost | skipped |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const h of report.harnesses) {
    lines.push(
      `| ${cell(h.harness)} | ${cell(h.model)} | ${h.passed}/${h.total} | ${pct(h.passRate)} | ${Math.round(h.medianWallMs)} | ${h.medianTurns} | ${h.inputTokens} | ${h.outputTokens} | ${usd(h.costUsd)} | ${h.skipped} |`,
    );
  }
  lines.push("");

  lines.push("## By tag");
  lines.push("");
  lines.push("| tag | pass | pass rate |");
  lines.push("|---|---|---|");
  for (const t of report.tags) {
    lines.push(`| ${cell(t.tag)} | ${t.passed}/${t.total} | ${pct(t.passRate)} |`);
  }
  lines.push("");

  const declared = BENCH_TAGS.filter((t) => !report.tags.some((r) => r.tag === t));
  if (declared.length > 0) {
    lines.push(`Tags with no recorded results: ${declared.join(", ")}`);
    lines.push("");
  }

  lines.push("## Totals");
  lines.push("");
  lines.push(`- cases: ${report.totals.cases}`);
  lines.push(`- results: ${report.totals.results}`);
  lines.push(`- passed: ${report.totals.passed}`);
  lines.push(`- skipped: ${report.totals.skipped}`);
  lines.push(`- wall time: ${Math.round(report.totals.wallMs)} ms`);
  lines.push(`- cost: ${usd(report.totals.costUsd)}`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}
