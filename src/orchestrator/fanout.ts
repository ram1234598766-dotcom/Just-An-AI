/**
 * Batch fan-out: one worker per row of a CSV or JSONL file.
 *
 * The shape Codex calls `spawn_agents_on_csv`, and the only reason it exists
 * separately from a plain list of workers is the input: a thousand rows are
 * usually a file on disk, and reading that file is where the untrusted-input
 * handling has to be.
 *
 * ## Why this is opt-in
 *
 * A fan-out multiplies provider spend by the row count without asking again per
 * row, so it is not something a run should discover it is allowed to do. The
 * plan's risk note for this phase says so directly, and {@link requireFanoutOptIn}
 * is that gate: a caller has to pass an explicit acknowledgement, and a run that
 * reaches a fan-out without one refuses instead of quietly spending.
 *
 * ## A bad row is a failed row, not a failed run
 *
 * Rows are independent, so one malformed line costs one task. The parse happens
 * before any worker starts, and every row is reported with its index — a
 * hundred-thousand-line file with a broken line 50,000 has to be resumable
 * without re-reading the whole thing to find out what happened.
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { scanSubagentReport } from "./inject.js";
import { runPool, type PoolOptions, type PoolResult, type Worker } from "./pool.js";
import type { Usage } from "../providers/types.js";

export type FanoutFormat = "csv" | "jsonl";

export interface FanoutRow {
  /** 0-based position in the file, so a report can point at the source line. */
  index: number;
  /** The parsed row. A CSV row is `{ column: value }`; a JSONL row is the object. */
  data: Record<string, unknown>;
}

export interface FanoutIssue {
  index: number;
  message: string;
}

export interface ParseResult {
  rows: FanoutRow[];
  issues: FanoutIssue[];
  /** Column names, for CSV. Empty for JSONL, which is self-describing. */
  columns: string[];
}

export interface FanoutOptions extends PoolOptions {
  /** Must be true. See {@link requireFanoutOptIn}. */
  fanout?: boolean;
  /** How a row becomes a worker. Receives the row, never the raw line. */
  buildWorker: (row: FanoutRow, context: FanoutContext) => Worker | Promise<Worker>;
  /** Header for the merged report. Default `"row"`. */
  labelHeader?: string;
}

export interface FanoutContext {
  /** 0-based row index. */
  index: number;
  /** Column value, or `undefined` when the column is absent. */
  column(name: string): string | undefined;
}

/** Rows past this are refused: a fan-out that runs away is a bill, not a result. */
export const MAX_FANOUT_ROWS = 5_000;

export class FanoutNotEnabledError extends Error {
  constructor() {
    super(
      "refusing to fan out: batch fan-out multiplies provider spend by the row count, so it needs an explicit opt-in (--fanout)",
    );
    this.name = "FanoutNotEnabledError";
  }
}

export function requireFanoutOptIn(enabled: boolean | undefined): void {
  if (enabled !== true) throw new FanoutNotEnabledError();
}

/**
 * Split one CSV line, honouring quoted fields and doubled quotes.
 *
 * A hand-rolled reader rather than a dependency, for the same reason Phase 18
 * uses a focused TOML parser instead of a general one: a batch fan-out is not
 * where a package should be added, and the alternative — `String.split(",")` —
 * silently corrupts any row containing a quoted comma, which is most real data.
 */
export function parseCsvLine(line: string, delimiter = ","): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Parse a batch file. The file is treated as untrusted: a line that is not the
 * declared shape becomes an issue against its index, never a throw that loses
 * the rows already parsed.
 */
export function parseFanoutFile(path: string, format: FanoutFormat): ParseResult {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  return format === "csv" ? parseCsv(raw) : parseJsonl(raw);
}

function parseCsv(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return { rows: [], issues: [], columns: [] };

  const columns = parseCsvLine(lines[0]!);
  const rows: FanoutRow[] = [];
  const issues: FanoutIssue[] = [];

  for (let i = 1; i < lines.length; i++) {
    if (rows.length >= MAX_FANOUT_ROWS) {
      issues.push({ index: i, message: `refused: more than ${MAX_FANOUT_ROWS} rows` });
      break;
    }
    const values = parseCsvLine(lines[i]!);
    if (values.length !== columns.length) {
      issues.push({
        index: i - 1,
        message: `row has ${values.length} field(s) but the header declares ${columns.length}`,
      });
      continue;
    }
    const data: Record<string, unknown> = {};
    columns.forEach((column, at) => {
      data[column] = values[at];
    });
    rows.push({ index: rows.length, data });
  }

  return { rows, issues, columns };
}

function parseJsonl(raw: string): ParseResult {
  const rows: FanoutRow[] = [];
  const issues: FanoutIssue[] = [];
  const lines = raw.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (rows.length >= MAX_FANOUT_ROWS) {
      issues.push({ index: rows.length, message: `refused: more than ${MAX_FANOUT_ROWS} rows` });
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (err) {
      issues.push({ index: rows.length, message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      issues.push({ index: rows.length, message: "line is not a JSON object" });
      continue;
    }
    rows.push({ index: rows.length, data: parsed as Record<string, unknown> });
  }

  return { rows, issues, columns: [] };
}

/** Run one worker per row, under the pool's concurrency and depth caps. */
export async function runFanout(path: string, format: FanoutFormat, options: FanoutOptions): Promise<FanoutReport> {
  requireFanoutOptIn(options.fanout);

  const absolute = isAbsolute(path) ? path : resolve(dirname(path), path);
  const parsed = parseFanoutFile(absolute, format);

  const workers: Worker[] = [];
  for (const row of parsed.rows) {
    const context: FanoutContext = {
      index: row.index,
      column: (name: string) => {
        const value = row.data[name];
        return value === undefined || value === null ? undefined : String(value);
      },
    };
    workers.push(await options.buildWorker(row, context));
  }

  const result: PoolResult = await runPool(workers, options);
  return { ...result, parseIssues: parsed.issues, columns: parsed.columns, rowCount: parsed.rows.length };
}

export interface FanoutReport extends PoolResult {
  parseIssues: FanoutIssue[];
  columns: string[];
  rowCount: number;
}

/**
 * Merge per-row results into one table, one section per row.
 *
 * A report rather than a table because a row's result can be multiline and
 * truncated, and a CSV cell containing both is worse than a readable list. The
 * header repeats per section so a section copied out of the middle still says
 * which row it was.
 *
 * Each result is passed through the injection scan on the way in. The pool
 * already scanned the worker's `output`, but a row's *prompt* is assembled from
 * the file, and a file can carry the same instruction text a report can.
 */
export function mergeFanoutReport(report: FanoutReport, labelHeader = "row"): string {
  const parts: string[] = [];
  const label = report.columns.length > 0 ? (report.columns[0] ?? labelHeader) : labelHeader;
  parts.push(`Fan-out: ${report.tasks.length} task(s) over ${report.rowCount} row(s).`);

  for (const issue of report.parseIssues) {
    parts.push(`  - line ${issue.index + 1} skipped: ${issue.message}`);
  }
  for (const refusal of report.refused) {
    parts.push(`  - task ${refusal.task.id} refused: ${refusal.reason}`);
  }

  for (const task of report.tasks) {
    const identity = describeRow(task);
    parts.push(`\n### ${label}: ${identity}`);
    if (task.status === "failed") {
      parts.push(`status: failed — ${task.error ?? "no reason recorded"}`);
      continue;
    }
    if (task.status === "cancelled") {
      parts.push("status: cancelled");
      continue;
    }
    if (task.status !== "completed") {
      parts.push(`status: ${task.status}`);
      continue;
    }
    parts.push(scanSubagentReport(task.result ?? "").text);
  }

  const usage: Usage = report.usage;
  parts.push(`\ntokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);
  return parts.join("\n");
}

function describeRow(task: { prompt: string }): string {
  const firstLine = task.prompt.split("\n")[0]?.trim() ?? "";
  const bounded = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  return bounded === "" ? "(unlabelled)" : bounded;
}
