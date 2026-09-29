import { describe, expect, it } from "vitest";
import { shouldLaunchTui } from "../src/cli/tui-default.js";
import type { TuiProbe } from "../src/cli/tui-default.js";

/**
 * A stand-in for the process streams.
 *
 * The point of these tests is that bare `jaa` must not hang a script, so the
 * decision is tested by the streams it refuses to trust rather than by running
 * the CLI.
 */
function streams(stdin: boolean, stdout: boolean, columns = 80): TuiProbe {
  return {
    stdin: { isTTY: stdin },
    stdout: { isTTY: stdout, columns },
  };
}

describe("shouldLaunchTui", () => {
  it("launches for a person at a terminal", () => {
    expect(shouldLaunchTui({}, streams(true, true))).toBe(true);
  });

  it("prints help when stdin is a pipe, however good stdout looks", () => {
    // `jaa | less` is a request for text. A TUI into a pipe is unreadable, and
    // a non-TTY stdin means there is nobody to type at it.
    expect(shouldLaunchTui({}, streams(false, true))).toBe(false);
  });

  it("prints help when stdout is a pipe, however good stdin looks", () => {
    // `jaa > out.txt` and `$(jaa)` both land here.
    expect(shouldLaunchTui({}, streams(true, false))).toBe(false);
  });

  it("prints help in CI, which often allocates a TTY for its log", () => {
    expect(shouldLaunchTui({ CI: "true" }, streams(true, true))).toBe(false);
    expect(shouldLaunchTui({ CI: "1" }, streams(true, true))).toBe(false);
  });

  it("treats CI=false and CI=0 as not CI", () => {
    // A shell that exports CI=0 to disable a tool has not opted out of the TUI.
    expect(shouldLaunchTui({ CI: "false" }, streams(true, true))).toBe(true);
    expect(shouldLaunchTui({ CI: "0" }, streams(true, true))).toBe(true);
  });

  it("honours JAA_NO_TUI as an escape hatch", () => {
    expect(shouldLaunchTui({ JAA_NO_TUI: "1" }, streams(true, true))).toBe(false);
  });

  it("honours an empty JAA_NO_TUI as unset, not as a denial", () => {
    // `JAA_NO_TUI=` is a common shape in a .env file, and reading it as "set but
    // empty" would silently disable the default for anyone who wrote it that way.
    expect(shouldLaunchTui({ JAA_NO_TUI: "" }, streams(true, true))).toBe(true);
  });

  it("lets JAA_TUI=1 force it on, for a terminal the probe misjudges", () => {
    expect(shouldLaunchTui({ JAA_TUI: "1" }, streams(true, true))).toBe(true);
  });

  it("refuses a zero-width terminal rather than letting Ink throw", () => {
    expect(shouldLaunchTui({}, streams(true, true, 0))).toBe(false);
  });

  it("still refuses in CI even with JAA_TUI set to anything but 1", () => {
    // The opt-in is a debugging switch, not a way to make a build stop and
    // prompt, so it is read strictly.
    expect(shouldLaunchTui({ CI: "true", JAA_TUI: "yes" }, streams(true, true))).toBe(false);
  });
});
