import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROVIDERS } from "../src/config/providers.js";
import { SetupScreen } from "../src/tui/setup.js";
import { backToProviders, choose, confirmKey, currentKeyUrl, initialSetupState, type SetupState } from "../src/tui/setup-state.js";

/**
 * Tests for the first-run gate.
 *
 * Both of these exist because the gate looked like it worked and did not:
 *
 *  - Enter on the key bar stored the key, printed "using OpenAI", and never
 *    released the screen. `Shell` only swaps in the chat when setup says it is
 *    finished, so a correct key produced a dead end with no error anywhere.
 *  - Ollama was filtered out of the provider list and reachable only through a
 *    `/api/tags` probe, so it was invisible to anyone who had not already pulled
 *    a model. The one option that needs no account was the one you could not see.
 *
 * Neither is a styling bug. Both are "the product silently does nothing", which
 * is the only class of failure worth a test that reads like a specification.
 */

const originalHome = process.env.JAA_HOME;
let home: string;

beforeEach(() => {
  const root = join(realpathSync.native(tmpdir()), `jaa-setup-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`);
  home = mkdtempSync(root);
  process.env.JAA_HOME = join(home, "home");
  mkdirSync(process.env.JAA_HOME, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Cleanup is not an assertion.
  }
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
});

/**
 * Keystrokes, spelled out.
 *
 * Written as escapes rather than pasted as literal control characters: a raw ESC
 * in a source file is invisible, survives copy-paste unpredictably, and reads as
 * a missing character in every diff. `stdin.write("[B")` is not a down arrow.
 */
const DOWN_ARROW = "[B";
const ENTER = "\r";

/** A state parked on the provider list, which is where first run lands with no Ollama. */
function atProviders(): SetupState {
  return { ...initialSetupState(), step: "choose-provider" };
}

function withKey(step: SetupState["step"], key: string, pending: SetupState["pending"] = { id: "openai", label: "OpenAI (GPT models)", keyUrl: "https://platform.openai.com/api-keys", envKeys: ["OPENAI_API_KEY"], keyringEnv: "JAA_OPENAI_API_KEY" }): SetupState {
  return { ...initialSetupState(), step, key, pending };
}

describe("setup: the key bar must release the screen", () => {
  it("reaches done when a key is confirmed", () => {
    // The state machine half: confirmKey is what the Enter handler calls.
    const next = confirmKey(withKey("enter-key", "sk-test-value"));
    expect(next.step).toBe("done");
    expect(next.key).toBe("");
  });

  it("calls onDone after a full key round-trip, which is the bug this file exists for", async () => {
    // The real sequence, driven through real keystrokes: pick the first provider,
    // paste a key, press Enter. `Shell` only swaps in the chat when `onDone`
    // fires, so without this the key is stored correctly and the person is
    // stranded on a confirmation screen with no error anywhere - which is
    // exactly what was reported.
    let done = 0;
    const { stdin, lastFrame, unmount } = render(React.createElement(SetupScreen, { onDone: () => (done += 1) }));

    // `detectSetup` probes for Ollama before it will show anything.
    await new Promise((r) => setTimeout(r, 2_500));
    expect(lastFrame()).toContain("pick a provider");

    stdin.write("\r"); // Enter on the first row: OpenAI
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? "").toContain("key");

    stdin.write("sk-not-a-real-key");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toContain("•"); // masked, not echoed

    stdin.write("\r"); // Enter on the key bar
    await new Promise((r) => setTimeout(r, 50));

    expect(done, "the chat was never released after a valid key").toBe(1);
    unmount();
  });

  it("refuses an empty key rather than storing nothing as configured", () => {
    const next = confirmKey(withKey("enter-key", "   "));
    expect(next.step).toBe("enter-key");
    expect(next.error).toBeDefined();
  });
});

describe("setup: Ollama is a visible option", () => {
  it("is in the provider list, not hidden behind a successful probe", () => {
    // The regression. Ollama used to be filtered out with `localOnly !== true`.
    const ids = initialSetupState().providers.map((p) => p.id);
    expect(ids).toContain("ollama");
  });

  it("is marked as needing no key", () => {
    const ollama = initialSetupState().providers.find((p) => p.id === "ollama");
    expect(ollama?.localOnly).toBe(true);
  });

  it("shows no key URL for Ollama", () => {
    // A signup URL on the one row that needs no signup is worse than no URL.
    const state = atProviders();
    const index = state.providers.findIndex((p) => p.id === "ollama");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(currentKeyUrl({ ...state, cursor: index })).toBeUndefined();
  });

  it("still shows the key URL for a hosted provider", () => {
    const state = atProviders();
    const index = state.providers.findIndex((p) => p.id === "openai");
    expect(currentKeyUrl({ ...state, cursor: index })).toBe("https://platform.openai.com/api-keys");
  });

  it("goes to the model list rather than to a key bar", () => {
    // Ollama has no key. Sending it to a key screen produces a bar that accepts
    // nothing and explains nothing.
    const state = atProviders();
    const index = state.providers.findIndex((p) => p.id === "ollama");
    const next = choose({ ...state, cursor: index });
    expect(next.step).toBe("choose-local");
    expect(next.pending).toBeUndefined();
  });

  it("lets Esc come back out of the model list", () => {
    // Otherwise "Ollama, but nothing pulled" has no exit but Ctrl+C, which
    // throws away the whole session.
    const state = choose({ ...atProviders(), cursor: 0 });
    const back = backToProviders({ ...state, step: "choose-local" });
    expect(back.step).toBe("choose-provider");
    expect(back.key).toBe("");
  });
});

describe("setup: the screen says what it needs to", () => {
  it("lists Ollama in the provider step, so the choice is on screen", async () => {
    // The report was "there is no ollama section". Asserted on the rendered
    // frame, because the state having it is not the same as the person seeing it.
    const { lastFrame, unmount } = render(React.createElement(SetupScreen, { onDone: () => undefined }));
    await new Promise((r) => setTimeout(r, 2_500));
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("Ollama");
    expect(frame.toLowerCase()).toContain("no key");
  });

  it("names the command to start Ollama when nothing is pulled", async () => {
    const { stdin, lastFrame, unmount } = render(React.createElement(SetupScreen, { onDone: () => undefined }));
    await new Promise((r) => setTimeout(r, 2_500));
    // Count provider rows, not screen lines: the banner and the hint are not
    // selectable and pressing Down for each of them lands somewhere else.
    const steps = Math.max(0, PROVIDERS.findIndex((p) => p.id === "ollama"));
    // A tick between presses. `useInput` turns each keystroke into a state
    // update, and nine writes with no gap in between coalesce into one - the
    // cursor moves once and the test fails for a reason that has nothing to do
    // with the screen.
    for (let i = 0; i < steps; i += 1) {
      stdin.write(DOWN_ARROW);
      await new Promise((r) => setTimeout(r, 25));
    }
    stdin.write(ENTER);
    await new Promise((r) => setTimeout(r, 80));
    const frame = lastFrame() ?? "";
    unmount();
    expect(frame).toContain("ollama serve");
    expect(frame).toContain("ollama pull llama3.2");
    expect(frame).toContain("Esc back");
  });
});
