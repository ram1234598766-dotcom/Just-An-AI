import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  deleteToStart,
  deleteWordBack,
  helpText,
  isCommand,
  isKnownCommand,
  matchingCommands,
  parseCommand,
  walkHistory,
} from "../src/tui/commands.js";

describe("slash commands", () => {
  it("recognises a command, and only a command", () => {
    expect(isCommand("/help")).toBe(true);
    expect(isCommand("  /help  ")).toBe(true);
    expect(isCommand("help")).toBe(false);
    expect(isCommand("what does /help mean")).toBe(false);
    expect(isCommand("")).toBe(false);
  });

  it("splits a name from its argument", () => {
    expect(parseCommand("/help")).toEqual({ name: "/help", argument: "" });
    expect(parseCommand("/rewind 3 ")).toEqual({ name: "/rewind", argument: "3" });
  });

  it("treats an unknown slash word as a command attempt", () => {
    // The caller decides what to do with it; this only asserts it is not a
    // prompt. A leading slash is a clear statement of intent, and forwarding a
    // typo'd command to the model would spend a call on nothing.
    const parsed = parseCommand("/nope");
    expect(parsed?.name).toBe("/nope");
    expect(isKnownCommand(parsed?.name ?? "")).toBe(false);
  });

  it("knows every command it advertises", () => {
    for (const command of COMMANDS) expect(isKnownCommand(command.name), command.name).toBe(true);
  });

  it("filters the palette by prefix", () => {
    expect(matchingCommands("").length).toBe(COMMANDS.length);
    expect(matchingCommands("/re").map((c) => c.name)).toEqual(["/rewind"]);
    expect(matchingCommands("/").length).toBe(COMMANDS.length);
    expect(matchingCommands("/zzz")).toEqual([]);
  });

  it("documents every command and the keys in /help", () => {
    const help = helpText();
    for (const command of COMMANDS) expect(help, command.name).toContain(command.name);
    expect(help).toContain("Ctrl+C");
    expect(help).toContain("history");
  });

  it("never advertises a command twice", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("line editing", () => {
  it("deletes the word before the caret, not the gap", () => {
    // Shell order: skip back over spaces, then over the word. Getting this
    // backwards deletes a space and leaves the word, which is maddening.
    expect(deleteWordBack("git commit ", 11)).toEqual({ text: "git ", caret: 4 });
    expect(deleteWordBack("git commit", 10)).toEqual({ text: "git ", caret: 4 });
  });

  it("is a no-op at the start of the line", () => {
    expect(deleteWordBack("hello", 0)).toEqual({ text: "hello", caret: 0 });
    expect(deleteWordBack("", 0)).toEqual({ text: "", caret: 0 });
  });

  it("deletes a run of whitespace when the caret is inside it", () => {
    // Whitespace is skipped, then the word behind it goes too, so repeated
    // presses always make progress rather than sometimes doing nothing.
    expect(deleteWordBack("one   ", 6)).toEqual({ text: "", caret: 0 });
    // Caret at 5 of "one····": the word goes and the two trailing spaces after
    // the caret are left alone, because they are not behind it.
    expect(deleteWordBack("one    ", 5)).toEqual({ text: "  ", caret: 0 });
    // Whitespace with no word behind it is still deleted — a key that removes
    // nothing is the one thing an editor must not do.
    expect(deleteWordBack("   ", 3)).toEqual({ text: "", caret: 0 });
  });

  it("edits at the caret rather than only at the end", () => {
    // Caret at 7 sits inside "one two", so only the word before it is removed
    // and the tail is untouched. Both spaces survive — index 3 separates what is
    // kept on the left from what is kept on the right.
    expect(deleteWordBack("one two three", 7)).toEqual({ text: "one  three", caret: 4 });
    expect(deleteWordBack("one two three", 13)).toEqual({ text: "one two ", caret: 8 });
  });

  it("clears to the start of the line for Ctrl+U", () => {
    expect(deleteToStart("hello world", 6)).toEqual({ text: "world", caret: 0 });
    expect(deleteToStart("hello", 0)).toEqual({ text: "hello", caret: 0 });
  });
});

describe("input history", () => {
  it("walks back through what was sent, newest first", () => {
    const history = ["first", "second"];
    const older = walkHistory(history, 0, "draft", "older");
    expect(older.text).toBe("second");
    const olderAgain = walkHistory(history, older.index, "draft", "older");
    expect(olderAgain.text).toBe("first");
  });

  it("stops at the oldest entry rather than going past it", () => {
    const history = ["first", "second"];
    const oldest = walkHistory(history, 2, "draft", "older");
    expect(oldest.text).toBe("first");
    expect(walkHistory(history, 2, "draft", "older").text).toBe("first");
  });

  it("returns to the draft after the newest entry", () => {
    // Walking forward past the newest prompt should restore what the user was
    // typing, not empty the box and lose it.
    const history = ["first", "second"];
    const back = walkHistory(history, 2, "half-typed", "older");
    expect(back.text).toBe("first");
    const forward = walkHistory(history, back.index, "half-typed", "newer");
    expect(forward.text).toBe("second");
    const past = walkHistory(history, 1, "half-typed", "newer");
    expect(past.text).toBe("half-typed");
  });

  it("does nothing with an empty history", () => {
    expect(walkHistory([], 0, "typing", "older")).toEqual({ text: "typing", index: 0 });
    expect(walkHistory([], 0, "typing", "newer")).toEqual({ text: "typing", index: 0 });
  });
});
