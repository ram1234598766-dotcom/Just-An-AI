/**
 * Whether bare `jaa` may start the TUI instead of printing help.
 *
 * Every condition here exists to protect a caller that is not a person:
 *
 *  - **Both ends must be a TTY.** A TUI writes escape sequences and repaints in
 *    place. Into a pipe that is unreadable, and with a non-TTY stdin there is
 *    nobody to type. Checking only stdout is the common mistake and is enough to
 *    hang a CI job.
 *  - **Not CI.** Many CI runners allocate a TTY for a human-facing log, and a
 *    build that stops to ask a question fails the job rather than serving anyone.
 *  - **Not already piped.** `jaa | less`, `jaa > out.txt` and `$(jaa)` are all
 *    requests for text, and silently swallowing them would be worse than the
 *    help output they replace.
 *  - **`JAA_NO_TUI` opts out.** An escape hatch that needs no flag and no
 *    argument, for a shell profile that wants `jaa` to mean help.
 *
 * Returns false rather than throwing on any doubt. The cost of a wrong `true` is
 * a hung process; the cost of a wrong `false` is help text, which is a smaller
 * mistake to make.
 */
/**
 * The part of `process` this decision reads.
 *
 * Narrowed on purpose rather than typed as the whole `process`: the test passes
 * a two-field stand-in, and a signature demanding the full process object would
 * force the test to construct one it does not own.
 */
export interface TuiProbe {
  stdin: { isTTY: boolean | undefined };
  stdout: { isTTY: boolean | undefined; columns: number | undefined };
}

export function shouldLaunchTui(env: NodeJS.ProcessEnv = process.env, streams: TuiProbe = process): boolean {
  if (env.JAA_NO_TUI !== undefined && env.JAA_NO_TUI !== "") return false;
  if (env.JAA_TUI === "1") return true;
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false") return false;
  if (!streams.stdin.isTTY || !streams.stdout.isTTY) return false;
  // A wide or narrow terminal is fine; a zero-width one cannot render anything,
  // and Ink would throw rather than degrade.
  return streams.stdout.columns !== 0;
}
