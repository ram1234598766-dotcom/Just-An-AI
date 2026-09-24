import { readFile, stat, writeFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { confinePath, MAX_TOOL_OUTPUT } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * Glob matching for workspace-only patterns. `pattern` is matched against
 * slash-normalized relative paths. Translates `*`, `?`, and `**` into a RegExp
 * with fixed handling of path separators (a plain `*` never crosses `/`).
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped: string[] = [];
  const parts = pattern.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isDoubleStar = part === "**";
    let body = "";
    for (const ch of part ?? "") {
      if (ch === "*") body += isDoubleStar ? ".*" : "[^/]*";
      else if (ch === "?") body += "[^/]";
      else body += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    if (isDoubleStar) escaped.push(".*");
    else escaped.push(body);
  }
  return new RegExp(`^${escaped.join("/")}$`);
}

const readFileSchema = z.object({ path: z.string().min(1) });
const writeFileSchema = z.object({ path: z.string().min(1), content: z.string() });
const listSchema = z.object({ path: z.string().min(1).default(".") });
const statSchema = z.object({ path: z.string().min(1) });
const globSchema = z.object({ pattern: z.string().min(1) });

async function readTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path } = readFileSchema.parse(args);
  const abs = confinePath(ctx, path);
  const buf = await readFile(abs);
  if (buf.subarray(0, 4096).includes(0)) {
    return `refusing to read binary file ${basename(abs)} (${buf.length} bytes)`;
  }
  const text = buf.toString("utf8");
  return text.length > MAX_TOOL_OUTPUT
    ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated ${text.length - MAX_TOOL_OUTPUT} chars]`
    : text;
}

async function writeTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path, content } = writeFileSchema.parse(args);
  const abs = confinePath(ctx, path);
  await writeFile(abs, content, "utf8");
  return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${abs}`;
}

async function listTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path } = listSchema.parse(args);
  const abs = confinePath(ctx, path);
  const entries = await readdir(abs, { withFileTypes: true });
  const lines = entries.map((e) => `${e.isDirectory() ? "dir " : "file"}  ${e.name}`);
  return clamp(lines);
}

async function statTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path } = statSchema.parse(args);
  const abs = confinePath(ctx, path);
  const s = await stat(abs);
  return [
    `path: ${abs}`,
    `size: ${s.size}`,
    `mtime: ${s.mtime.toISOString()}`,
    `type: ${s.isDirectory() ? "directory" : s.isFile() ? "file" : "other"}`,
  ].join("\n");
}

async function globTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { pattern } = globSchema.parse(args);
  const rx = globToRegExp(pattern);
  const matches: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const name = e.name;
      const relPath = prefix === "" ? name : `${prefix}/${name}`;
      const full = join(dir, name);
      if (rx.test(relPath) || rx.test(`${relPath}/`)) matches.push(relPath);
      if (e.isDirectory()) await walk(full, relPath);
    }
  }

  await walk(ctx.root, "");
  if (matches.length === 0) return "no matches";
  return clamp(matches);
}

function clamp(list: string[]): string {
  const MAX = 500;
  if (list.length <= MAX) return list.join("\n");
  return `${list.slice(0, MAX).join("\n")}\n… [${list.length - MAX} more]`;
}

export const fsTools: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a text file from the workspace. Refuses binary files.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "path, relative to the workspace root" } },
      required: ["path"],
    },
    schema: readFileSchema,
    run: readTool,
  },
  {
    name: "write_file",
    description: "Create or overwrite a file in the workspace with UTF-8 text.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "path, relative to the workspace root" },
        content: { type: "string", description: "full new file content" },
      },
      required: ["path", "content"],
    },
    schema: writeFileSchema,
    run: writeTool,
  },
  {
    name: "list_dir",
    description: "List entries in a workspace directory (dirs and files).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "directory path; defaults to '.'" } },
    },
    schema: listSchema,
    run: listTool,
  },
  {
    name: "stat",
    description: "Report size, mtime, and type of a workspace path.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "path" } },
      required: ["path"],
    },
    schema: statSchema,
    run: statTool,
  },
  {
    name: "glob",
    description: "Find workspace files matching a pattern (*, ?, **).",
    inputSchema: {
      type: "object",
      properties: { pattern: { type: "string", description: "e.g. **\\*.ts" } },
      required: ["pattern"],
    },
    schema: globSchema,
    run: globTool,
  },
];