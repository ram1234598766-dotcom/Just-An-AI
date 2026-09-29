/**
 * What the operator can type that jaa, not the model, handles.
 *
 * Every one of these is a local action. None of them is sent to a provider, and
 * that is the property worth stating: a slash command that quietly cost a model
 * call would be a bad surprise in a bill.
 */
export interface Command {
  name: string;
  /** One line, shown in the palette. */
  summary: string;
  /** Arguments the command needs, for the palette's hint. */
  args?: string;
}

export const COMMANDS: Command[] = [
  { name: "/help", summary: "list these commands and key bindings" },
  { name: "/rewind", summary: "restore the working tree to an earlier turn" },
  { name: "/model", summary: "show the model answering right now" },
  { name: "/sessions", summary: "list saved sessions" },
  { name: "/clear", summary: "clear the screen, keeping the conversation" },
  { name: "/new", summary: "clear the screen and start a fresh conversation" },
  { name: "/tokens", summary: "show token use and the context gauge" },
  { name: "/exit", summary: "quit (also Ctrl+D, or Ctrl+C twice)" },
];

/** The longest command name, for padding the palette. */
const NAME_WIDTH = Math.max(...COMMANDS.map((c) => c.name.length));

/** Whether `input` is a slash command at all, as opposed to a prompt that starts with `/`. */
export function isCommand(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/**
 * The command in `input`, or undefined when it is not one jaa handles.
 *
 * Unknown commands are *not* returned as undefined-and-therefore-sent-to-the-model
 * without a word: a leading `/` is a strong signal of intent, and silently
 * spending a model call on a typo'd command is the surprising outcome. So an
 * unknown `/foo` is still a command attempt, and the caller is told.
 */
export function parseCommand(input: string): { name: string; argument: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const argument = space === -1 ? "" : trimmed.slice(space + 1).trim();
  return { name, argument };
}

/** True when the name is one jaa handles. */
export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((c) => c.name === name);
}

/** The palette rows, including any prefix-filtered subset. */
export function matchingCommands(prefix: string): Command[] {
  if (prefix === "") return COMMANDS;
  const lower = prefix.toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(lower));
}

/** The help text: every command, aligned, plus the keys. */
export function helpText(): string {
  const commands = COMMANDS.map((c) => `  ${c.name.padEnd(NAME_WIDTH)}  ${c.summary}`).join("\n");
  return [
    "commands",
    commands,
    "",
    "keys",
    "  Enter          send",
    "  ↑ / ↓          walk input history",
    "  Ctrl+W         delete the previous word",
    "  Ctrl+U         clear the line",
    "  Ctrl+R         expand or collapse a tool result",
    "  Ctrl+C ×2      quit",
    "  Ctrl+D         quit",
    "  Esc Esc        rewind the last edit",
    "  /rewind        pick a turn to restore",
  ].join("\n");
}

/**
 * Move a caret back one word.
 *
 * Skips the run of non-space characters, then the spaces before it — the same
 * order a shell uses, so Ctrl+W deletes the word under the cursor and not the
 * gap in front of it. A caret at the start of the string is a no-op rather than
 * an error, because keypresses arrive whether or not they make sense.
 */
export function deleteWordBack(text: string, caret: number): { text: string; caret: number } {
  if (caret <= 0) return { text, caret };
  // One rule, applied in two steps: skip any whitespace back from the caret,
  // then delete the word before it. A shell does the same, so "git commit " plus
  // Ctrl+W leaves "git " rather than "git  " with a doubled space.
  //
  // The whitespace and the word are removed together, which is why the slice runs
  // to the caret rather than to the point where the word ends.
  let start = caret;
  while (start > 0 && /\s/.test(text[start - 1] ?? "")) start -= 1;
  while (start > 0 && !/\s/.test(text[start - 1] ?? "")) start -= 1;
  return { text: text.slice(0, start) + text.slice(caret), caret: start };
}

/** Delete from the caret to the start of the line, for Ctrl+U. */
export function deleteToStart(text: string, caret: number): { text: string; caret: number } {
  if (caret <= 0) return { text, caret };
  return { text: text.slice(caret), caret: 0 };
}

/**
 * Walk input history.
 *
 * `older` moves towards what was typed before; the empty slot past the newest
 * entry is the current draft, so a user who walks back and then forwards gets
 * their unsent text back rather than an empty box.
 */
export function walkHistory(
  history: readonly string[],
  index: number,
  draft: string,
  direction: "older" | "newer",
): { text: string; index: number } {
  if (history.length === 0) return { text: draft, index: 0 };
  if (direction === "older") {
    // `index` is "how far back we already are", so 0 is the draft and the first
    // press lands on the newest entry. Clamped at the length, which is the
    // oldest, so repeated presses stop rather than wrap around.
    const next = Math.min(index + 1, history.length);
    return { text: history[history.length - next] ?? draft, index: next };
  }
  // Forwards. Past the newest entry the draft comes back, so walking up and
  // then down does not lose what was being typed.
  const next = Math.max(0, index - 1);
  if (next === 0) return { text: draft, index: 0 };
  return { text: history[history.length - next] ?? draft, index: next };
}
