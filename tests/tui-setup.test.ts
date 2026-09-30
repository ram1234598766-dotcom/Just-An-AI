import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatModelSize, listLocalModels } from "../src/tui/local-models.js";
import { themeByName, THEMES, THEME_NAMES, DEFAULT_THEME } from "../src/tui/theme.js";
import { PROVIDERS } from "../src/config/providers.js";
import { loadSettings, saveSettings } from "../src/config/settings.js";

let tmp: string;
const originalHome = process.env.JAA_HOME;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-setup-"));
  process.env.JAA_HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tags = (models: { name: string; size?: number }[]): typeof fetch =>
  (async () => new Response(JSON.stringify({ models }), { status: 200 })) as unknown as typeof fetch;

describe("listLocalModels", () => {
  it("reads the model names and sizes", async () => {
    const found = await listLocalModels(500, {
      fetchImpl: tags([
        { name: "llama3.2:3b", size: 2_000_000_000 },
        { name: "qwen2.5-coder:7b", size: 4_700_000_000 },
      ]),
    });
    expect(found.map((m) => m.name)).toEqual(["qwen2.5-coder:7b", "llama3.2:3b"]);
  });

  it("offers the biggest model first, not the alphabetically first", async () => {
    // Alphabetical order would bury a 7b under every 1b and 3b prefixed with a
    // letter, which is the model someone actually wants.
    const found = await listLocalModels(500, {
      fetchImpl: tags([
        { name: "a-1b", size: 1_000_000_000 },
        { name: "z-70b", size: 40_000_000_000 },
      ]),
    });
    expect(found[0]?.name).toBe("z-70b");
  });

  it("returns nothing when no server is listening", async () => {
    const refused = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(listLocalModels(200, { fetchImpl: refused })).resolves.toEqual([]);
  });

  it("returns nothing on a non-200, and nothing on a shape it does not understand", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(listLocalModels(200, { fetchImpl: notFound })).resolves.toEqual([]);
    const odd = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(listLocalModels(200, { fetchImpl: odd })).resolves.toEqual([]);
  });

  it("drops entries with no name rather than showing a blank row", async () => {
    const found = await listLocalModels(200, {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ models: [{ size: 1 }, { name: "good" }] }), { status: 200 })) as unknown as typeof fetch,
    });
    expect(found.map((m) => m.name)).toEqual(["good"]);
  });

  it("formats a size for a row and nothing for a missing one", () => {
    // Binary units, matching what `ls -h` and every disk tool show. 4.7e9 bytes
    // is 4.4 GiB, and a row that disagreed with `du` would look wrong.
    expect(formatModelSize(4_700_000_000)).toBe("4.4 GB");
    expect(formatModelSize(4.7 * 1024 ** 3)).toBe("4.7 GB");
    expect(formatModelSize(512_000_000)).toBe("488 MB");
    expect(formatModelSize(0)).toBe("");
    expect(formatModelSize(Number.NaN)).toBe("");
  });
});

describe("provider metadata for the setup screen", () => {
  it("names where to get a key for every provider that needs one", () => {
    // "Paste your key" without saying where to obtain one is a dead end for
    // anyone who has not already set one up.
    for (const provider of PROVIDERS) {
      if (provider.localOnly === true) continue;
      expect(provider.keyUrl, `${provider.id} has no keyUrl`).toMatch(/^https:\/\//);
    }
  });

  it("needs no URL for a local provider", () => {
    const ollama = PROVIDERS.find((p) => p.id === "ollama");
    expect(ollama?.localOnly).toBe(true);
    expect(ollama?.keyUrl).toBeUndefined();
  });
});

describe("themes", () => {
  it("has a palette for every name it offers", () => {
    for (const name of THEME_NAMES) {
      const theme = themeByName(name);
      expect(theme.accent, name).toBeTruthy();
      expect(theme.error, name).toBeTruthy();
      expect(theme.rule, name).toBeTruthy();
    }
  });

  it("falls back to the default rather than refusing to start", () => {
    // A typo in a config file must not be the reason jaa does not run. The cost
    // of getting it wrong is default colours; the cost of throwing is no TUI.
    expect(themeByName("no-such-theme")).toBe(DEFAULT_THEME);
    expect(themeByName(undefined)).toBe(DEFAULT_THEME);
  });

  it("offers a no-colour theme and a brighter one", () => {
    // The two that actually get asked for: a terminal that renders 256 colours
    // badly, and default dim text that is too dim to read.
    expect(themeByName("mono").accent).toBe("white");
    expect(themeByName("high-contrast").accent).toBe("cyanBright");
    expect(Object.keys(THEMES).length).toBe(THEME_NAMES.length);
  });

  it("gives every theme a full palette, so switching cannot leave a colour unset", () => {
    for (const name of THEME_NAMES) {
      const theme = themeByName(name);
      for (const field of ["running", "ok", "code", "url", "user"] as const) {
        expect(theme[field], `${name}.${field}`).toBeTruthy();
      }
    }
  });
});

describe("setup state", () => {
  it("asks to be run when nothing is configured", async () => {
    const { shouldRunSetup, alreadyConfigured } = await import("../src/tui/setup-state.js");
    saveSettings({ ...loadSettings(), defaultProvider: undefined });
    expect(alreadyConfigured()).toBe(false);
    expect(shouldRunSetup()).toBe(true);
  });

  it("stays out of the way when a provider is already chosen", async () => {
    const { shouldRunSetup } = await import("../src/tui/setup-state.js");
    expect(shouldRunSetup(true), "an explicit --provider is configuration").toBe(false);
  });

  it("leaves a pasted key behind when the cursor moves to another provider", async () => {
    const { initialSetupState, moveCursor, backToProviders } = await import("../src/tui/setup-state.js");
    const state = { ...initialSetupState(), step: "enter-key" as const, key: "sk-ant-secret", cursor: 0 };
    const moved = moveCursor(state, 1);
    // A key belongs to the provider it was pasted for. Keeping it in the bar
    // after moving on is how a Groq key ends up stored as an OpenAI one, which
    // fails later and looks like a bad key.
    expect(moved.key).toBe("");
    const back = backToProviders(state);
    expect(back.key).toBe("");
    expect(back.step).toBe("choose-provider");
    expect(back.pending).toBeUndefined();
  });

  it("refuses an empty key rather than storing nothing", async () => {
    const { initialSetupState, confirmKey } = await import("../src/tui/setup-state.js");
    const state = {
      ...initialSetupState(),
      step: "enter-key" as const,
      key: "   ",
      pending: initialSetupState().providers[0],
    };
    const after = confirmKey(state);
    expect(after.step).toBe("enter-key");
    expect(after.error).toMatch(/paste a key/);
  });
});
