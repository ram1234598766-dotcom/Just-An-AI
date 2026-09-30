/**
 * Render the first-run screen through Ink's own renderer and print it.
 *
 * A setup screen is the first thing a new user sees, and it is pure layout —
 * there is nothing here for a unit test to assert that looking at it does not.
 * So it is looked at, through the same renderer and the same TTY-shaped stream
 * `tui-render-check.mts` uses.
 *
 *   npx tsx tools/tui-setup-preview.mts            # no local models
 *   npx tsx tools/tui-setup-preview.mts --local    # with three local models
 */
import React from "react";
import { PassThrough, Writable } from "node:stream";
import { render } from "ink";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JAA_HOME = mkdtempSync(join(tmpdir(), "jaa-setup-preview-"));

class TtyStdout extends Writable {
  columns = 92;
  rows = 40;
  isTTY = true;
  buffer = "";
  _write(chunk, _encoding, callback) {
    this.buffer += chunk.toString("utf8");
    callback();
  }
  get screen() {
    return this.buffer
      .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/\u001B\][^\u0007]*\u0007/g, "");
  }
}

class TtyStdin extends PassThrough {
  isTTY = true;
  isRaw = true;
  setRawMode() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

const withLocal = process.argv.includes("--local");

if (withLocal) {
  // Stand in for a machine with Ollama running, so the local branch can be seen.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        models: [
          { name: "qwen2.5-coder:7b", size: 4_700_000_000 },
          { name: "llama3.2:3b", size: 2_000_000_000 },
          { name: "deepseek-r1:14b", size: 9_000_000_000 },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
} else {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
}

const { SetupScreen } = await import("../src/tui/setup.js");
const stdout = new TtyStdout();
const app = render(React.createElement(SetupScreen, { onDone: () => app.unmount() }), {
  stdout,
  stdin: new TtyStdin(),
  patchConsole: false,
  exitOnCtrlC: false,
});

await new Promise((resolve) => setTimeout(resolve, 1500));
console.log(stdout.screen.trim());
app.unmount();
