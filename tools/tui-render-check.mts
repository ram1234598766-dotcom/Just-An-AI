/**
 * Render the real TUI through Ink's own renderer against a TTY-shaped stream.
 *
 * `ink-testing-library` renders the component but not the terminal: no size, no
 * cursor, no repaint handling. This is the closest honest check on a host with
 * no console — a writable stream that reports `isTTY`, a real column count, and
 * a real row count, so Ink takes the same code path it takes for a person.
 *
 * A pty would be better, and is not available here: node-pty on Windows needs
 * `AttachConsole`, which fails outside an interactive console. That is a limit
 * of this environment, so it is stated rather than papered over.
 */
import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { ChatApp } from "../src/tui/app.js";

/** A stdout that looks like a terminal to Ink, and keeps what is written. */
class TtyStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;
  buffer = "";

  constructor() {
    super();
    this.on("data", () => undefined);
  }

  _write(chunk, _encoding, callback) {
    this.buffer += chunk.toString("utf8");
    callback();
  }

  get screen() {
    // Strip the escapes Ink uses for cursor movement and colour, so what is
    // asserted is the text a person would read.
    // eslint-disable-next-line no-control-regex
    return this.buffer.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\u001B\][^\u0007]*\u0007/g, "");
  }
}

const stdout = new TtyStream();

const model = {
  provider: "demo",
  model: "demo-model",
  adapter: {
    id: "demo",
    chat: async () => {
      throw new Error("no turn is sent by this check");
    },
  },
};

/**
 * A stdin that behaves like a terminal.
 *
 * `isTTY: true` is the flag Ink tests before it mounts a raw-mode handler, and
 * `setRawMode` is a no-op because this stream is not a real device. That is the
 * honest simulation: Ink takes the same branch it takes for a person at a
 * terminal, which is the branch under test.
 */
class TtyStdin extends PassThrough {
  isTTY = true;
  isRaw = true;
  setRawMode() {
    return this;
  }
  // A real TTY is a `ReadStream` over a `tty.ReadStream`, which has libuv
  // handles and so `ref`/`unref`. A bare stream does not, and Ink calls both
  // when it mounts the input handler. No-ops here because there is no handle to
  // keep the process alive for.
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

const app = render(
  React.createElement(ChatApp, {
    model,
    systemPrompt: "you are jaa",
    executeTool: async () => "ok",
    resumeMessages: [],
    interactive: true,
  }),
  {
    stdout,
    stdin: new TtyStdin(),
    patchConsole: false,
    exitOnCtrlC: false,
  },
);

await new Promise((resolve) => setTimeout(resolve, 1500));

// The first frame is the whole story here: nothing has been typed, so the screen is
// whatever Ink painted on mount.
const screen = stdout.screen;
const checks = [
  ["status bar names the model", /jaa demo\/demo-model/],
  ["turn counter", /turn 0/],
  ["context gauge drawn", /ctx [█░]{5,}/],
  ["token counter", /tok 0in\/0out/],
  ["idle hint names the keys", /Enter send/],
  ["idle hint points at /help", /\/help/],
  ["prompt glyph drawn", /❯/],
  ["caret block drawn", /█/],
  ["a real column width was used", /ctx[^\n]{0,40}/],
];

let failed = 0;
for (const [label, pattern] of checks) {
  const ok = pattern.test(screen);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

if (failed > 0) {
  console.log("--- screen ---");
  console.log(screen);
}

app.unmount();
console.log(failed === 0 ? "REAL RENDER OK" : `REAL RENDER ${failed} check(s) failed`);
process.exitCode = failed === 0 ? 0 : 1;
