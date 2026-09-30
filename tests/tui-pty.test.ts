import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The TUI in a real terminal.
 *
 * **This file does not belong in the default suite.** It needs a pty, a WSL
 * boot, and twenty seconds of uncontended terminal time, and asking that of a
 * test pool running forty other files — several of which spawn real language
 * servers — produced a different victim on every run. A check that is only
 * reliable on an idle machine is a check that gets skipped, so it runs on its
 * own instead: `npm run test:tui`, and its own step in CI.
 *
 * Every other harness takes Ink's word that it is talking to a terminal:
 * `ink-testing-library` has no size, and `tools/tui-render-check.mts` supplies a
 * TTY-shaped writable. Neither exercises what a pty actually decides — the
 * winsize from ioctl, cursor visibility, synchronized output, repaint-in-place —
 * and that is exactly where a TUI is quietly broken.
 *
 * A pty is not reachable from Windows directly: `node-pty` needs `AttachConsole`,
 * which fails outside an interactive console. WSL 2 is available and Python's
 * `pty` module is in every image, so the driver is Python, and it runs under WSL
 * on Windows and natively elsewhere.
 *
 * **Two recordings, not one per assertion.** Each drive costs a WSL start and a
 * node boot, and a pty check that spawns a terminal per fact is a check that
 * will be slow and flaky. Every property below is visible in one recording.
 *
 * Skipped, loudly, where there is no pty: a missing terminal must never be
 * reported as a passing interface.
 */

const repo = (relative: string): string => fileURLToPath(new URL(`../${relative}`, import.meta.url));
/** Where the repository lives from the *driver's* point of view. */
const REPO_FOR_DRIVER = process.platform === "win32" ? "/mnt/c/Users/Mrityunjay/jaa" : process.cwd();
const RECORDING = repo(".tmp-tui-pty.bin");
const RECORDING_TXT = repo(".tmp-tui-pty.bin.txt");

function ptyAvailable(): boolean {
  if (!existsSync(repo("dist/cli/index.js"))) return false;
  if (process.platform === "win32") {
    return spawnSync("wsl", ["-d", "kali-linux", "--", "python3", "-c", "import pty"], { timeout: 30_000 }).status === 0;
  }
  return spawnSync("python3", ["-c", "import pty"], { timeout: 15_000 }).status === 0;
}

const available = ptyAvailable();

interface Drive {
  text: string;
  raw: string;
  /** Negative means the driver had to stop it; 0 means it quit on its own. */
  exit: number;
}

/** Drive the real CLI in a real pty and return what a person would see. */
function drive(keys: string, provision: boolean): Drive {
  // The executable is the command, not the first argument. Passing it twice
  // makes python try to open a file called `python3`, which fails in 45
  // milliseconds and looks like a missing driver.
  const scriptArgs = [
    `${REPO_FOR_DRIVER}/tools/tui-pty-drive.py`,
    REPO_FOR_DRIVER,
    `${REPO_FOR_DRIVER}/.tmp-tui-pty.bin`,
    keys,
    ...(provision ? ["--provision"] : []),
  ];
  const command = process.platform === "win32" ? "wsl" : "python3";
  const args = process.platform === "win32" ? ["-d", "kali-linux", "--", ...scriptArgs] : scriptArgs;
  const result = spawnSync(command, args, { timeout: 300_000, encoding: "utf8" });
  if (!existsSync(RECORDING_TXT)) {
    throw new Error(`pty driver produced no recording: ${result.stderr ?? result.stdout}`);
  }
  const exit = /child exit=(-?\d+)/.exec(result.stdout ?? "");
  return {
    text: readFileSync(RECORDING_TXT, "utf8"),
    raw: readFileSync(RECORDING, "utf8"),
    exit: exit?.[1] === undefined ? -999 : Number(exit[1]),
  };
}

afterAll(() => {
  for (const name of [".tmp-tui-pty.bin", ".tmp-tui-pty.bin.txt", ".pty-home"]) {
    rmSync(repo(name), { force: true, recursive: true });
  }
});

describe.skipIf(!available)("the TUI in a real pty", () => {
  it("shows the first-run screen, with a key URL, when nothing is configured", () => {
    const { text } = drive("none", false);
    // Rendering the provider list at all is the proof the terminal reported a
    // real width. A 0x0 pty winsize makes Ink size itself to nothing, and the
    // symptom is an empty recording that looks exactly like a broken interface.
    expect(text, "the TUI rendered nothing in a real terminal").toMatch(/pick a provider/);
    expect(text).toMatch(/get a key at/);
    expect(text).toMatch(/https:\/\//);
    expect(text).toMatch(/OpenAI|Anthropic/);
  });

  it("reaches the chat, draws a status bar, and repaints in place", () => {
    // One recording, three facts. A keypress so there is a second frame: a single
    // frame needs no erase, and asserting on one would assert on nothing.
    const { text, raw, exit } = drive("type:hello", true);

    // The gate is a gate: a configured provider gets past it.
    expect(text).toMatch(/Enter send/);
    expect(text).toMatch(/turn 0/);
    // The status bar, which only lays out if the terminal reported a width.
    expect(text).toMatch(/tok\s+\d+in\/\d+out/);

    // Terminal control sequences no fake writable ever produces.
    expect(raw, "the cursor was never hidden").toContain("\u001B[?25l");
    // DECSET 2026 - synchronized output, which Ink emits to avoid a torn frame.
    expect(raw, "no synchronized-output sequence").toMatch(/\u001B\[\?2026h/);
    // Ink rewrites a row by erasing it first, which is what stops a repaint
    // from scrolling the transcript off the top of the terminal.
    expect(raw, "nothing was erased, so a repaint would scroll the screen").toMatch(/\u001B\[2K/);
    expect(raw, "the cursor never moved back up, so nothing was repainted").toMatch(/\u001B\[\d*A/);

    // Ctrl+D is a graceful quit, so the cursor must be handed back. A process
    // the driver had to kill cannot do that, and a killed run proves nothing
    // either way.
    if (exit === 0) {
      expect(raw, "a clean exit must restore the cursor").toMatch(/\u001B\[\?25h/);
    }
  });

  it("handles a command without needing a provider", () => {
    const { text } = drive("type:/help,enter", true);
    // Local by construction: if this needed a model call, there would be no
    // output at all, because nothing is configured beyond the provider id.
    expect(text, "/help produced no output").toMatch(/rewind/);
  });
});
