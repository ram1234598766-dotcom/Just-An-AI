/**
 * The `lsp_*` tools: code intelligence as the agent can actually use it.
 *
 * ## Why these are tools and not just loop wiring
 *
 * Phase 17 also wires diagnostics into the loop automatically, so the agent
 * never has to ask. These exist for the cases automatic injection cannot cover:
 * "where is this defined", "what else calls this", "what does this function
 * return". An agent that has to grep for those is guessing, and guessing about
 * types is the single most expensive mistake a coding agent makes.
 *
 * ## The results are text, not structure
 *
 * A location comes back as a `file:///…` URI with a line range. Printed raw that
 * is useless to a model *and* to a human: the model has to strip the scheme and
 * guess the workspace root, and a path like `file:///c%3A/Users/...` is worse
 * still. So every result is rendered as a workspace-relative `path:line`, which
 * is the form the rest of jaa's tools already use and the form a model can
 * actually act on.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./types.js";
import type { LspClient } from "../lsp/client.js";
import type { LspManager } from "../lsp/manager.js";
import { confinePath } from "./registry.js";

/** A position as the tools accept it. 1-based lines, to match what editors show. */
const positionSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  character: z.number().int().min(1).default(1),
});

function toManagerPosition(line: number, character: number): { line: number; character: number } {
  return { line: Math.max(0, line - 1), character: Math.max(0, character - 1) };
}

/**
 * A `file://` URI as a workspace-relative path.
 *
 * Returns `undefined` for a URI outside the workspace, rather than a `../..`
 * path. A relative path that walks out of the root is not something the agent
 * should be told to open, and `confinePath` would refuse it anyway — so
 * reporting it as unavailable here is honest instead of leaving a tool result
 * that contradicts the next one.
 */
function renderUri(uri: string, root: string): string | undefined {
  if (!uri.startsWith("file://")) return undefined;
  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    return undefined;
  }
  const rel = relative(root, resolve(filePath));
  if (rel === "" || rel.startsWith("..") || /^[A-Za-z]:/.test(rel)) return undefined;
  return rel.replace(/\\/g, "/");
}

/** The manager to use. Injected by the host; absent means the feature is off. */
export type LspResolver = (ctx: ToolContext) => LspManager | undefined;

const unavailable =
  "code intelligence is not enabled for this session. Start jaa with `--lsp` (or set `lsp.enabled`) to use a language server.";

function managerOr(ctx: ToolContext, resolve_: LspResolver): LspManager | undefined {
  return resolve_(ctx);
}

function diagnosticsTool(resolve_: LspResolver): ToolDefinition {
  return {
    name: "lsp_diagnostics",
    description:
      "Report the language server's diagnostics for a file: type errors, unresolved imports, lint-level problems. " +
      "Faster and more complete than reading the file and reasoning about it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "file path, relative to the workspace root" } },
      required: ["path"],
    },
    schema: z.object({ path: z.string().min(1) }),
    async run(input, ctx) {
      const { path } = z.object({ path: z.string().min(1) }).parse(input);
      const manager = managerOr(ctx, resolve_);
      if (manager === undefined) return unavailable;

      const abs = confinePath(ctx, path);
      let text: string | undefined;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        // A file that does not exist yet is exactly the case where diagnostics
        // are wanted — the agent just wrote it, or is about to.
        text = undefined;
      }
      const outcome = await manager.diagnostics(abs, text);
      if (outcome.status === "unavailable") return `no diagnostics available: ${outcome.reason}`;
      if (outcome.status === "error") return outcome.reason;

      const { items } = outcome.result;
      if (items.length === 0) return `${path}: no problems reported by the ${outcome.language} language server`;

      const lines = [`${path}: ${items.length} problem(s) from the ${outcome.language} language server`];
      for (const item of items.slice(0, 50)) {
        const sev = item.severity === 2 ? "warning" : item.severity === 3 ? "info" : item.severity === 4 ? "hint" : "error";
        const at = item.range?.start;
        const where = at === undefined ? path : `${path}:${at.line + 1}:${at.character + 1}`;
        const code = item.code === undefined ? "" : ` (${String(item.code)})`;
        lines.push(`  [${sev}] ${where} ${item.message.replace(/\s+/g, " ")}${code}`);
      }
      if (items.length > 50) lines.push(`  … ${items.length - 50} more`);
      return lines.join("\n");
    },
  };
}

function definitionTool(resolve_: LspResolver): ToolDefinition {
  return {
    name: "lsp_definition",
    description: "Find where the symbol at a position is defined. Use instead of grepping for a name.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "1-based line of the symbol" },
        character: { type: "number", description: "1-based column" },
      },
      required: ["path", "line"],
    },
    schema: positionSchema,
    async run(input, ctx) {
      const { path, line, character } = positionSchema.parse(input);
      const manager = managerOr(ctx, resolve_);
      if (manager === undefined) return unavailable;
      return navigate(manager, ctx, path, line, character, "definition");
    },
  };
}

function referencesTool(resolve_: LspResolver): ToolDefinition {
  return {
    name: "lsp_references",
    description: "List every place a symbol is used. Use before renaming or changing a signature.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "1-based line of the symbol" },
        character: { type: "number", description: "1-based column" },
      },
      required: ["path", "line"],
    },
    schema: positionSchema,
    async run(input, ctx) {
      const { path, line, character } = positionSchema.parse(input);
      const manager = managerOr(ctx, resolve_);
      if (manager === undefined) return unavailable;
      return navigate(manager, ctx, path, line, character, "references");
    },
  };
}

function hoverTool(resolve_: LspResolver): ToolDefinition {
  return {
    name: "lsp_hover",
    description: "Show the inferred type and signature at a position. The cheapest way to check a type without editing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        line: { type: "number", description: "1-based line" },
        character: { type: "number", description: "1-based column" },
      },
      required: ["path", "line"],
    },
    schema: positionSchema,
    async run(input, ctx) {
      const { path, line, character } = positionSchema.parse(input);
      const manager = managerOr(ctx, resolve_);
      if (manager === undefined) return unavailable;
      return navigate(manager, ctx, path, line, character, "hover");
    },
  };
}

/**
 * Shared body of the three navigation tools.
 *
 * A server that does not implement a feature answers with a JSON-RPC error, and
 * surfacing that to the model wastes a turn and teaches it the tool is broken.
 * So the capability is checked first and an honest "not supported" is returned
 * instead.
 */
async function navigate(
  manager: LspManager,
  ctx: ToolContext,
  path: string,
  line: number,
  character: number,
  feature: "definition" | "references" | "hover",
): Promise<string> {
  const abs = confinePath(ctx, path);
  const language = manager.languageFor(abs);
  if (language === undefined) return `no ${feature} available: jaa has no language server for this file type`;

  const session = await manager.navigationSession(abs);
  if (session === "error") {
    return `no ${feature} available: the ${language} language server is not usable here`;
  }
  if (!session.client.supports(feature)) {
    return `the ${language} language server does not support ${feature}`;
  }

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    return `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`;
  }

  // The server answers about its buffer, not the disk, and the two differ right
  // after the agent wrote the file — which is exactly when these are used.
  session.client.openDocument(pathToFileURL(abs).href, language, text);

  try {
    const pos = toManagerPosition(line, character);
    const result = await request(session.client, session.uri, feature, pos);
    return renderNavigation(result, ctx, feature, path);
  } catch (err) {
    return `the ${language} language server could not answer ${feature}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Issue the navigation request.
 *
 * One switch rather than a callback passed in from each tool, so the URI the
 * server is asked about is the one the session already resolved. A closure
 * capturing it from the tool body is the same answer with one more place for
 * the two to disagree.
 */
function request(
  client: LspClient,
  uri: string,
  feature: "definition" | "references" | "hover",
  pos: { line: number; character: number },
): Promise<unknown> {
  switch (feature) {
    case "definition":
      return client.definition(uri, pos);
    case "references":
      return client.references(uri, pos);
    case "hover":
      return client.hover(uri, pos);
  }
}

function renderNavigation(result: unknown, ctx: ToolContext, feature: string, path: string): string {
  if (result === null || result === undefined) return `${path}: no ${feature} found`;

  if (feature === "hover") {
    const hover = result as { contents?: unknown };
    const text = renderContents(hover.contents);
    return text === "" ? `${path}: no hover information` : `${path}\n${text}`;
  }

  const locations = Array.isArray(result) ? result : [result];
  const lines: string[] = [];
  for (const entry of locations.slice(0, 100)) {
    const record = entry as { uri?: unknown; range?: { start?: { line?: number; character?: number } }; targetUri?: unknown; targetSelectionRange?: { start?: { line?: number } } };
    // `LocationLink` uses targetUri; `Location` uses uri. Both are legal.
    const rawUri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : undefined;
    if (rawUri === undefined) continue;
    const rendered = renderUri(rawUri, ctx.root);
    // A location outside the workspace is reported as a path, not dropped: the
    // agent still needs to know the symbol lives somewhere it cannot edit.
    if (rendered === undefined) {
      lines.push(`  (outside the workspace) ${rawUri}`);
      continue;
    }
    const line = record.range?.start?.line ?? record.targetSelectionRange?.start?.line;
    lines.push(`  ${rendered}${line === undefined ? "" : `:${line + 1}`}`);
  }
  if (lines.length === 0) return `${path}: no ${feature} found`;
  return [`${feature} of ${path}: ${lines.length} location(s)`, ...lines].join("\n");
}

function renderContents(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((entry) => (typeof entry === "string" ? entry : renderContents(entry)))
      .filter((text) => text !== "")
      .join("\n");
  }
  if (contents !== null && typeof contents === "object") {
    const record = contents as { value?: unknown };
    return typeof record.value === "string" ? record.value : "";
  }
  return "";
}

/**
 * The LSP tools, or nothing.
 *
 * Returning an empty list when no resolver is supplied is what keeps them out of
 * the advertised tool set entirely: a model offered a tool that always answers
 * "not enabled" spends a turn discovering that, every session.
 */
export function lspTools(resolve_: LspResolver): ToolDefinition[] {
  return [diagnosticsTool(resolve_), definitionTool(resolve_), referencesTool(resolve_), hoverTool(resolve_)];
}
