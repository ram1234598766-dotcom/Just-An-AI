import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { confinePath } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const hunkSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string().min(1),
});
const patchSchema = z.object({
  path: z.string().min(1),
  hunks: z.array(hunkSchema).min(1).max(20),
});

/**
 * Applies a curated patch: every hunk's `oldText` must appear exactly once in
 * the current file content, and hunks apply in order against the evolving
 * text. Fails atomically — the file is untouched unless every hunk matches.
 */
async function patchTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { path, hunks } = patchSchema.parse(args);
  const abs = confinePath(ctx, path);
  const original = await readFile(abs, "utf8");

  let current = original;
  for (const { oldText, newText } of hunks) {
    const first = current.indexOf(oldText);
    if (first === -1) throw new Error(`hunk not found — no exact match for ${JSON.stringify(oldText.slice(0, 80))}`);
    if (current.indexOf(oldText, first + 1) !== -1) {
      throw new Error(`hunk is ambiguous — ${JSON.stringify(oldText.slice(0, 80))} matches more than once`);
    }
    current = current.slice(0, first) + newText + current.slice(first + oldText.length);
  }

  if (current === original) throw new Error("no hunks matched — file unchanged");
  await writeFile(abs, current, "utf8");
  return `patched ${abs}: ${hunks.length} hunk(s) applied`;
}

export const patchTools: ToolDefinition[] = [
  {
    name: "patch",
    description:
      "Apply exact-anchor edits to a file. Each hunk replaces one unique occurrence of oldText with newText. Fails atomically on any mismatch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "path, relative to the workspace root" },
        hunks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              oldText: { type: "string", description: "text to replace (must appear exactly once)" },
              newText: { type: "string", description: "replacement text" },
            },
            required: ["oldText", "newText"],
          },
        },
      },
      required: ["path", "hunks"],
    },
    schema: patchSchema,
    run: patchTool,
  },
];