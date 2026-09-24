import { stdin } from "node:process";

/**
 * Reads the whole piped stdin as a trimmed string, or undefined when stdin is a
 * TTY (interactive). Used to accept secrets via `echo $KEY | jaa ...` without
 * ever echoing them on the command line.
 */
export async function readStdinIfPiped(): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text.length > 0 ? text : undefined;
}