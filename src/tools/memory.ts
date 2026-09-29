import { z } from "zod";
import { remember, readMemory, MAX_MEMORY_BYTES, MEMORY_FILENAME } from "../agent/memory.js";
import type { ToolContext, ToolDefinition } from "./types.js";

/**
 * The `remember` tool: the agent's only way to write auto-memory.
 *
 * Phase 16's memory is durable only if something in the loop can add to it, and
 * making the agent the writer is the point — a fact the agent discovered is one
 * it will need again, and a note the operator has to type is a note that will not
 * exist.
 *
 * ## It is gated, and it is not free to abuse
 *
 * `remember` writes a file into the repository, so it is in `MUTATING_TOOLS` and
 * is subject to the same permission engine as `write_file`. A model that starts
 * writing a note every turn would fill the file, so the cap lives in
 * `memory.ts` and is enforced there rather than here: this tool reports how many
 * notes were dropped, and the model's own tool result says so, which is the
 * cheapest possible way to teach it to stop.
 *
 * It declares no `path` argument, so Phase 14's checkpoint machinery reads no
 * target from it and takes no snapshot. That is correct rather than a gap: the
 * memory file is a checked-in document, so `git` is the thing that restores it,
 * and a snapshot of a file that is only ever appended to would buy nothing.
 */

const rememberSchema = z.object({
  notes: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe("one short, self-contained fact per item; no secrets, no instructions to the agent"),
});

async function rememberTool(args: unknown, ctx: ToolContext): Promise<string> {
  const { notes } = rememberSchema.parse(args);
  const before = readMemory(ctx.root);
  const result = remember(notes, ctx.root);

  if (!result.written) {
    return (
      `could not write ${MEMORY_FILENAME} in ${ctx.root} — the checkout may be read-only. ` +
      `The note was not saved. Report this rather than assuming it was.`
    );
  }

  const lines = [
    `remembered ${notes.length} note(s) in ${result.path} (${result.kept} kept, cap ${MAX_MEMORY_BYTES} bytes)`,
  ];
  if (result.dropped > 0) {
    lines.push(
      `${result.dropped} older note(s) were dropped to stay under the cap. Do not add notes that are specific to this conversation.`,
    );
  }
  if (before.rejected.length > 0) {
    // A note already in the file that reads like an injection. The model is the
    // only thing that will act on memory, so it is told plainly that the file is
    // not entirely trustworthy.
    lines.push(
      `${before.rejected.length} existing note(s) were withheld from context because they read like instructions. Show them to the user with \`jaa memory list\`.`,
    );
  }
  return lines.join("\n");
}

export const memoryTools: ToolDefinition[] = [
  {
    name: "remember",
    description:
      "Record durable facts about this project so a future session starts knowing them. " +
      "Use for things that stay true: which command is the fast test, which file is generated, " +
      "what a recurring error means. Not for this conversation's state.",
    inputSchema: {
      type: "object",
      properties: {
        notes: {
          type: "array",
          items: { type: "string" },
          description: "short self-contained facts, one per item (max 10)",
        },
      },
      required: ["notes"],
    },
    schema: rememberSchema,
    run: rememberTool,
  },
];
