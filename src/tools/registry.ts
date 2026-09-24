import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolContext, ToolDefinition } from "./types.js";
import type { ToolDef } from "../providers/types.js";

const execFileAsync = promisify(execFile);

/** Result cap applied to every tool so a single tool never floods context. */
export const MAX_TOOL_OUTPUT = 80_000;

/** Clamp output to MAX_TOOL_OUTPUT chars, marking truncation. */
export function clampOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated]`;
}

/**
 * Resolves `p` (absolute or relative to `ctx.cwd`) and refuses any path that
 * escapes `ctx.root`. Path traversal is the prime tool security boundary.
 */
export function confinePath(ctx: ToolContext, p: string): string {
  if (p.includes("\0")) throw new Error(`path contains a null byte: ${JSON.stringify(p)}`);
  const abs = isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
  const root = resolve(ctx.root);
  const rel = relative(root, abs);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) throw new Error(`path escapes the workspace root: ${p}`);
  return abs;
}

export interface Registry {
  /** Advertise every registered tool to the model. */
  list(): ToolDef[];
  /** Execute a tool by name with a JSON-encoded arguments string. */
  execute(name: string, argsJson: string, ctx: ToolContext): Promise<string>;
}

/**
 * A context-free tool registry: tools are registered once, and each execution
 * receives a fresh ToolContext. Argument failures and handler throws come back
 * as result strings (never reject out of the loop), so the model can recover.
 */
export function createRegistry(tools: ToolDefinition[]): Registry {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  return {
    list() {
      return [...byName.values()].map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },

    async execute(name, argsJson, ctx) {
      const tool = byName.get(name);
      if (!tool) return clampOutput(`unknown tool "${name}"`);

      let input: unknown;
      try {
        input = argsJson === "" ? {} : JSON.parse(argsJson);
      } catch {
        return clampOutput(`tool "${name}": arguments are not valid JSON: ${argsJson}`);
      }

      const parsed = tool.schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
          .join("; ");
        return clampOutput(`tool "${name}": invalid arguments — ${issues}`);
      }

      try {
        return clampOutput(await tool.run(parsed.data, ctx));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return clampOutput(`tool "${name}" failed: ${msg}`);
      }
    },
  };
}

/** Runs an external binary with an arg array (no shell) — used by bash/git tools. */
export async function runProcess(
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; maxOutput?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const max = opts.maxOutput ?? MAX_TOOL_OUTPUT;
  try {
    const result = await execFileAsync(command, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: max * 2,
      windowsHide: true,
      encoding: "utf8",
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: typeof e.code === "number" ? e.code : null,
    };
  }
}