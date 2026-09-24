import { z } from "zod";
import { MAX_TOOL_OUTPUT } from "./registry.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const fetchSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().min(500).max(60_000).default(15_000),
});

async function fetchTool(args: unknown, _ctx: ToolContext): Promise<string> {
  const { url, timeoutMs } = fetchSchema.parse(args);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("only http(s) URLs are allowed");
  }

  const start = Date.now();
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
    headers: { "user-agent": "jaa-agent/0.1" },
  });
  const text = await res.text();
  const clipped =
    text.length > MAX_TOOL_OUTPUT
      ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n… [truncated ${text.length - MAX_TOOL_OUTPUT} chars]`
      : text;
  return `status ${res.status} ${res.statusText} · ${(Date.now() - start)}ms · content-type ${res.headers.get("content-type") ?? "unknown"}\n${clipped}`;
}

export const webTools: ToolDefinition[] = [
  {
    name: "fetch_url",
    description: "GET an http(s) URL and return its body as text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "absolute http(s) URL" },
        timeoutMs: { type: "integer", description: "timeout in ms (default 15000, max 60000)" },
      },
      required: ["url"],
    },
    schema: fetchSchema,
    run: fetchTool,
  },
];