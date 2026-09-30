#!/usr/bin/env python3
"""Drive the real TUI in a real pty and record what a person would see.

This is the check that closes Phase 20's limit L1. Every other harness takes
Ink's word that it is talking to a terminal: `ink-testing-library` has no size,
and `tools/tui-render-check.mts` supplies a TTY-shaped writable. Neither
exercises what a pty actually decides - the winsize from ioctl, cursor
visibility, synchronized output, repaint-in-place - and that is exactly where a
TUI is quietly broken.

A pty is not reachable from Windows directly: `node-pty` needs `AttachConsole`,
which fails outside an interactive console. WSL 2 is available and Python's
`pty` module is in every image, so the driver is Python and it runs under WSL on
Windows and natively elsewhere.

Python rather than `script(1)` for one concrete reason: `script` forwards its
own stdin to the pty, and a piped producer races the child's startup badly
enough that the keystrokes are dropped and the app sits there until it is
killed. Here the keys are written to the pty master by this process at a known
moment, which is the only way to know they arrived.

    tools/tui-pty-drive.py <repo-root> <out-file> <keys-spec> [--provision]

`keys-spec` is a comma-separated list of named keys rather than an escape
string, because an escape string is mangled by whichever shell is between the
caller and here before Python ever sees it:

    type:/help,enter        down,down,enter        ctrl-d

Named keys: type:<text>, enter, up, down, left, right, backspace, escape,
ctrl-c, ctrl-d, ctrl-r, ctrl-w, ctrl-u, or `none`.
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

ROWS = 30
COLS = 100
QUIT_SECONDS = 1.5

# Pause between keystrokes, in seconds.
#
# Long enough for a repaint to land on a real terminal, short enough that a
# six-step flow does not turn the suite into a minute of sleeping. 0.45s is
# about what a person takes to glance at a screen and decide the next key; less
# than that and the TUI has usually not finished rendering the screen whose
# handler you are about to hit.
KEY_GAP = 0.45
# Bounded, because a check that can hang is a check nobody runs, and because
# eight assertions at forty seconds each is a suite nobody waits for.
HARD_LIMIT = 18.0
FIRST_FRAME_BYTES = 80
# Long enough for a cold start to finish booting WSL and loading node, and short
# enough that the suite is not the slowest thing anyone runs. Three attempts
# rather than one: the first `node` load comes off /mnt/c, a Windows 9p mount,
# and is markedly slower than every one after it. The failure is a known, bounded
# environment cost rather than a property of the interface, so it is retried and
# then still reported.
RETRIES = 3

ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\r")

NAMED = {
    "enter": b"\r",
    "up": b"\x1b[A",
    "down": b"\x1b[B",
    "left": b"\x1b[D",
    "right": b"\x1b[C",
    "backspace": b"\x7f",
    "escape": b"\x1b",
    "ctrl-c": b"\x03",
    "ctrl-d": b"\x04",
    "ctrl-r": b"\x12",
    "ctrl-w": b"\x17",
    "ctrl-u": b"\x15",
}


def parse_keys(spec):
    """Turn the spec into the list of keystrokes to write to the pty master.

    A list, not one blob, and that is the whole point.

    Written as a single `os.write` the keys arrive in one burst, and a TUI built
    on React coalesces the state updates: the process sees the last key, the
    intermediate screens never exist, and the recording shows a screen that was
    only ever on screen for a few milliseconds - if at all. That is fine for a
    one-key probe like `/help`. It is useless for first-run setup, where the flow
    is pick a provider, type a key, confirm, and every step depends on the one
    before it having been rendered.

    So each keystroke is written separately, with the caller giving the TUI time
    to paint in between. What a person does is press Enter, wait to see the next
    screen, then press Enter again.
    """
    if spec.strip() in ("", "none"):
        return []
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if part.startswith("type:"):
            out.append(part[len("type:") :].encode("utf-8"))
        elif part in NAMED:
            out.append(NAMED[part])
        else:
            raise SystemExit(f"unknown key {part!r}; try one of {sorted(NAMED)} or type:<text>")
    return out


def set_winsize(fd, rows, cols):
    """The winsize the child reads via ioctl.

    Load-bearing, and the failure it prevents is silent. A pty with a 0x0
    winsize makes `process.stdout.columns` 0, Ink sizes itself to nothing, and
    the TUI renders an empty frame while looking perfectly healthy. Setting the
    COLUMNS environment variable does not help, because Node reads the width from
    the terminal, not from the environment.
    """
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def run_once(repo, out_path, keys, provision, hard_limit):
    entry = os.path.join(repo, "dist", "cli", "index.js")
    if not os.path.isfile(entry):
        raise SystemExit(f"no {entry} - run npm run build first")

    # A private home, so a developer's real keys and sessions are neither read
    # nor written. With nothing configured the first-run screen shows, which is
    # the state a new user is in. --provision writes a config so the chat itself
    # is driven, for checking the transcript rather than the gate.
    home = os.path.join(os.path.dirname(os.path.abspath(out_path)), ".pty-home")
    os.makedirs(home, exist_ok=True)
    # Reset, every run. Writing the config only when provisioning leaves the
    # previous run's file in place, so a later run meant to see the first-run
    # screen inherits a configured provider and silently tests the chat instead.
    # A harness whose result depends on what ran before it is not a harness.
    config = os.path.join(home, "config.json")
    if os.path.exists(config):
        os.remove(config)
    if provision:
        with open(config, "w", encoding="utf-8") as handle:
            handle.write('{"defaultProvider":"ollama"}')

    env = dict(os.environ)
    env["TERM"] = "xterm-256color"
    env["JAA_HOME"] = home
    env.pop("JAA_NO_TUI", None)
    env.pop("CI", None)

    master, slave = pty.openpty()
    set_winsize(slave, ROWS, COLS)

    # Confirm the terminal is usable *before* blaming the TUI for an empty
    # recording, because a pty with a 0x0 winsize makes Ink render nothing at all
    # and the two look identical from the outside.
    #
    # The probe has to run with its stdout on the *pty*: a pipe has no `columns`
    # at all, so measuring one reports `undefined` and looks like a broken winsize
    # when the winsize is fine.
    probe = subprocess.Popen(
        ["node", "-e", "process.stdout.write(String(process.stdout.columns))"],
        stdout=slave,
        stderr=slave,
        stdin=slave,
    )
    seen = b""
    probe_deadline = time.time() + 20
    while time.time() < probe_deadline:
        ready, _, _ = select.select([master], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            seen += chunk
            if seen.strip():
                break
        if probe.poll() is not None and not ready:
            break
    probe.wait(timeout=5)
    columns = seen.decode("ascii", "replace").strip()
    if columns != str(COLS):
        print(
            f"the pty reports {columns or '(nothing)'} columns, not {COLS} - "
            "Ink sizes itself to a zero-width terminal and renders an empty frame",
            file=sys.stderr,
        )
        return 1
    child = subprocess.Popen(
        ["node", "dist/cli/index.js", "chat", "--no-tools", "--no-skills"],
        cwd=repo,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)

    chunks = []
    total = 0
    deadline = time.time() + hard_limit
    started = time.time()
    send_at = quit_at = None
    sent_count = 0
    quit = False

    try:
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                chunks.append(data)
                total += len(data)
                if send_at is None and total > FIRST_FRAME_BYTES:
                    # Wait for the first frame rather than sleeping a fixed
                    # amount. A cold start can exceed any sleep short enough to
                    # keep the suite quick, and the symptom is a recording of the
                    # keys you typed and nothing else - which reads as a broken
                    # interface and is really a race in the harness.
                    send_at = time.time() + 0.6
                    # Not armed yet. `quit_at` is set once the last keystroke has
                    # gone out, so a six-step flow is not cut off while it is
                    # still being typed.
                continue

            now = time.time()
            if sent_count < len(keys) and send_at is not None and now >= send_at:
                # One keystroke per tick of the send schedule, not one burst.
                # `KEY_GAP` is the pause a person takes to see the screen change
                # before pressing the next key, and a TUI that has not repainted
                # has not yet installed the handler for the next screen.
                os.write(master, keys[sent_count])
                sent_count += 1
                send_at = now + KEY_GAP
                if sent_count >= len(keys):
                    quit_at = send_at + QUIT_SECONDS
            if not quit and quit_at is not None and now >= quit_at:
                # Ctrl+D is the single-press quit, so the two-press gesture under
                # test is not the one used to end the run.
                os.write(master, b"\x04")
                quit = True
            if quit and now >= quit_at + 2.0:
                break
            if child.poll() is not None and now - started > 1.0:
                break
    finally:
        if child.poll() is None:
            # Signal the whole process group: node can leave a language server
            # or a sandbox helper behind, and those outlive the parent.
            try:
                os.killpg(os.getpgid(child.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        os.close(master)

    raw = b"".join(chunks)
    text = ANSI.sub(b"", raw).decode("utf-8", "replace")
    with open(out_path, "wb") as handle:
        handle.write(raw)
    with open(out_path + ".txt", "w", encoding="utf-8") as handle:
        handle.write(text)

    # The exit code is part of the answer. A TUI that exits immediately has not
    # rendered nothing because of a terminal problem, and a check that reports
    # both as "empty recording" has thrown the diagnosis away.
    print(f"child exit={child.returncode} (negative means the driver stopped it)")
    print(f"recorded {len(raw)} raw bytes / {len(text)} text bytes")
    return 0 if len(text) >= 40 else 1


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    repo, out_path, keys_spec = sys.argv[1], sys.argv[2], sys.argv[3]
    provision = "--provision" in sys.argv[4:]
    keys = parse_keys(keys_spec)

    # One retry. A cold WSL start can eat the whole budget before node executes a
    # line, which produces an empty recording indistinguishable from a TUI that
    # renders nothing. Retrying once separates "the environment was slow" from
    # "the interface is broken"; a second empty recording is still a failure.
    status = 1
    for attempt in range(1, RETRIES + 1):
        status = run_once(repo, out_path, keys, provision, HARD_LIMIT)
        if status == 0:
            return 0
        if attempt < RETRIES:
            print("empty recording - retrying once, this looks like a cold start", file=sys.stderr)
    return status


if __name__ == "__main__":
    sys.exit(main())
