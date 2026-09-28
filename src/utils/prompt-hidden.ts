import { spawn } from "node:child_process";
import { ReadStream as TtyReadStream } from "node:tty";

/**
 * Reading a secret from a terminal WITHOUT echoing it.
 *
 * ## Why this exists at all
 *
 * `readline`'s `question()` writes every keystroke to the output stream. That is
 * correct for a provider id and wrong for a credential: the operator types a
 * GitHub token, and the whole thing is now in their scrollback, in a screen
 * share, in a terminal-recording tool, and in whatever screenshots a bug report
 * collects. `setup.ts` had exactly that for every provider API key.
 *
 * ## The rule this module is built around
 *
 * **If echo cannot be suppressed, this refuses. It never falls back to an
 * echoing read.** A fallback would be indistinguishable from a working
 * implementation to the person using it, and the failure mode is the secret
 * appearing on screen. A loud failure at least happens while someone is
 * watching. Every branch below therefore either returns a value that was
 * genuinely read with echo off, or throws.
 *
 * ## Per platform
 *
 * - **POSIX**: the classic raw-mode loop — `setRawMode(true)` gives an
 *   unbuffered, unechoed terminal, and the key stream is decoded by hand.
 * - **win32**: Node has no console-mode API, so a short PowerShell child
 *   clears `ENABLE_ECHO_INPUT` on the shared console handle and calls
 *   `ReadConsole`. The child inherits the console (not a pipe) and returns the
 *   line on its own stdout, which is a pipe. If any console call fails the
 *   child exits with a distinct code and this throws rather than degrading.
 *
 * ## Deliberately not supported here
 *
 * - **Non-TTY stdin.** A pipe is not a terminal and there is nothing to turn
 *   echo off on. The caller is told to pipe the value in instead, which is the
 *   better answer anyway: it never reaches the screen at all.
 * - **An "are you sure" second prompt.** There is nothing to confirm about a
 *   paste, and a confirmation step that echoes is the bug this replaces.
 */

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";
const BACKSPACE_ALT = "\b";
const ENTER = ["\r", "\n"];

/**
 * A backstop against an operator who walked away from a live prompt. Long
 * enough that no realistic paste hits it.
 *
 * The cost of firing is real and is worth stating: killing the PowerShell child
 * skips its `finally`, so the console is left with echo disabled until something
 * else sets the mode back (`mode con` in cmd, or a new window). That is a
 * nuisance, not a disclosure — the secret was never printed either way.
 */
const WIN32_READ_TIMEOUT_MS = 10 * 60_000;

/** Aborts a Ctrl+C on POSIX without letting the default handler also kill us. */
const SIGINT = "SIGINT";

/**
 * The PowerShell program. Plain `$name` variables only — no `${...}`, so it can
 * live in a template literal safely.
 *
 * Exit codes are the channel back to Node; each one means a *different* console
 * call failed, and the caller reports them differently. `$ErrorActionPreference`
 * is not set: every call is checked explicitly, and a preference that turned a
 * throw into a non-zero exit would collapse all three cases into one.
 */
const WIN32_READ_CONSOLE = `
$sig = '[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern System.IntPtr GetStdHandle(int nStdHandle); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(System.IntPtr h, out uint m); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(System.IntPtr h, uint m); [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadConsole(System.IntPtr h, System.Text.StringBuilder b, uint n, out uint r, System.IntPtr c);'
Add-Type -MemberDefinition $sig -Name K32 -Namespace Jaa
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$h = [Jaa.K32]::GetStdHandle(-10)
$mode = [uint32]0
if (-not [Jaa.K32]::GetConsoleMode($h, [ref]$mode)) { exit 11 }
$quiet = [uint32]($mode -band (-bnot [uint32]4))
if (-not [Jaa.K32]::SetConsoleMode($h, $quiet)) { exit 12 }
try {
  $sb = New-Object System.Text.StringBuilder 8192
  $read = [uint32]0
  if (-not [Jaa.K32]::ReadConsole($h, $sb, [uint32]8192, [ref]$read, [System.IntPtr]::Zero)) { exit 13 }
  [Console]::Out.Write($sb.ToString())
}
finally {
  [void][Jaa.K32]::SetConsoleMode($h, $mode)
}
exit 0
`;

/** Base64 of UTF-16LE: the only encoding `-EncodedCommand` decodes. */
function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Why a Windows read failed, by the child's exit code. */
function win32Failure(code: number | null): string {
  if (code === 11) {
    return "the terminal is not a console this process can read with echo disabled — refusing to read the secret, because falling back to an echoing read would print it";
  }
  if (code === 12 || code === 13) {
    return "the terminal refused to switch into no-echo mode — refusing to read the secret, because falling back to an echoing read would print it";
  }
  return "the no-echo reader did not complete — refusing to read the secret, because falling back to an echoing read would print it";
}

/**
 * Reads one line from the console with echo off, via a PowerShell child.
 *
 * Resolves with the raw line. Rejects on every failure — there is no branch
 * that returns a line it did not read with echo disabled.
 */
function readHiddenWin32(question: string): Promise<string> {
  process.stderr.write(question);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-EncodedCommand", encodeCommand(WIN32_READ_CONSOLE)],
      // `inherit` on fd 0 is load-bearing: the child needs the real console
      // input handle, and a pipe here would make `GetStdHandle` return that
      // pipe, `GetConsoleMode` fail, and the read refuse for the wrong reason.
      // fd 1 is a pipe so the line comes back to us instead of onto the screen.
      { stdio: ["inherit", "pipe", "pipe"], shell: false },
    );

    const chunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, WIN32_READ_TIMEOUT_MS);

    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.resume();

    child.on("error", (err: Error) => {
      finish(() =>
        reject(
          new Error(
            `could not start the no-echo reader (${err.message}) — refusing to read the secret, because falling back to an echoing read would print it`,
          ),
        ),
      );
    });

    child.on("close", (code: number | null) => {
      if (code === 0) {
        const line = Buffer.concat(chunks).toString("utf8");
        finish(() => {
          process.stderr.write("\n");
          resolve(line);
        });
        return;
      }
      finish(() => reject(new Error(win32Failure(code))));
    });
  });
}

/**
 * Reads one line from a POSIX TTY with echo off.
 *
 * Raw mode means Node hands us keystrokes one at a time and the terminal does
 * not print them, so the editing keys have to be handled here: backspace
 * deletes without redrawing, Ctrl+C aborts, and Ctrl+D on an empty line is EOF.
 */
function readHiddenPosix(question: string, stdin: TtyReadStream): Promise<string> {
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";

    const detach = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      process.removeListener(SIGINT, onSignal);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };

    const onData = (chunk: Buffer): void => {
      for (const ch of chunk.toString("utf8")) {
        if (ENTER.includes(ch)) {
          detach();
          resolve(value);
          return;
        }
        if (ch === CTRL_C) {
          detach();
          reject(new Error("cancelled"));
          return;
        }
        if (ch === CTRL_D) {
          detach();
          if (value === "") {
            reject(new Error("no value typed before end-of-input"));
          } else {
            resolve(value);
          }
          return;
        }
        if (ch === BACKSPACE || ch === BACKSPACE_ALT) {
          // Code point, not code unit: a secret may legitimately contain a
          // character outside the BMP, and half a surrogate pair is not a
          // character anybody can delete.
          value = [...value].slice(0, -1).join("");
          continue;
        }
        // Every other C0/C1 control byte is dropped rather than stored: it is
        // never part of a token, and letting one through is how a pasted
        // escape sequence ends up in a credential.
        if (ch < " " || (ch >= "\u007F" && ch <= "\u009F")) continue;
        value += ch;
      }
    };

    const onEnd = (): void => {
      detach();
      reject(new Error("end of input before a value was typed"));
    };

    const onError = (err: Error): void => {
      detach();
      reject(new Error(`could not read from the terminal: ${err.message}`));
    };

    // The console's own Ctrl+C is not delivered as a `data` event in raw mode
    // on every terminal, so SIGINT is handled too. A secret is never read as a
    // result of a cancel.
    const onSignal = (): void => {
      detach();
      reject(new Error("cancelled"));
    };

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onError);
    process.once(SIGINT, onSignal);
  });
}

/**
 * Asks for a secret and returns it without ever putting it on screen.
 *
 * The prompt goes to **stderr** so that a secret read on stdout cannot be
 * captured into a pipeline or a log by accident. The returned string is the
 * exact line the operator typed; callers trim it.
 *
 * Throws — never falls back — when the input is not a TTY, when the terminal
 * cannot be put into a no-echo mode, or when the read is interrupted (Ctrl+C,
 * EOF). Callers are expected to treat every throw as "no secret was read".
 *
 * @example
 * const token = await promptHidden("Paste your GitHub token (input is hidden): ");
 */
export async function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!(stdin instanceof TtyReadStream) || stdin.isTTY !== true) {
    throw new Error(
      "refusing to prompt for a secret without an interactive terminal — there is no echo to suppress on a pipe, " +
        "and reading it visibly would print the secret. Pipe the value in instead, e.g. " +
        '`printf %s "$TOKEN" | jaa key set github`.',
    );
  }
  return process.platform === "win32" ? readHiddenWin32(question) : readHiddenPosix(question, stdin);
}
