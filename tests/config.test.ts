import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvLayers, resetEnvLayers, findSecret } from "../src/config/env.js";
import { hasKey, listKeyMeta, maskSecret, readKeyring, removeKey, setKey } from "../src/config/keyring.js";
import { providerById } from "../src/config/providers.js";
import {
  defaultSettings,
  getSetting,
  loadSettings,
  saveSettings,
  setSetting,
} from "../src/config/settings.js";
import { runSetup } from "../src/config/setup.js";

let tmp: string;
const originalHome = process.env.JAA_HOME;
const originalKeys: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jaa-config-"));
  process.env.JAA_HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.JAA_HOME;
  else process.env.JAA_HOME = originalHome;
  for (const key of originalKeys) delete process.env[key];
  originalKeys.length = 0;
  resetEnvLayers();
  rmSync(tmp, { recursive: true, force: true });
});

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  originalKeys.push(key);
}

describe("env precedence", () => {
  it("process env beats project .env which beats home .env", () => {
    const proj = join(tmp, "proj");
    mkdirSync(proj);
    writeFileSync(join(proj, ".env"), "JAA_TEST_KEY=from-project\nPROJECT_ONLY=1\n");
    const homeEnv = join(tmp, ".env");
    writeFileSync(homeEnv, "JAA_TEST_KEY=from-home\nHOME_ONLY=2\n");

    setEnv("JAA_TEST_KEY", "from-process");
    const withProcess = new EnvLayers(proj, homeEnv);
    expect(withProcess.get("JAA_TEST_KEY")).toEqual({ value: "from-process", source: "process" });

    delete process.env.JAA_TEST_KEY;
    const projectWins = new EnvLayers(proj, homeEnv);
    expect(projectWins.get("JAA_TEST_KEY")).toEqual({ value: "from-project", source: "project" });

    writeFileSync(join(proj, ".env"), "PROJECT_ONLY=1\n");
    const homeWins = new EnvLayers(proj, homeEnv);
    expect(homeWins.get("JAA_TEST_KEY")).toEqual({ value: "from-home", source: "home" });
  });

  it("higher layers fill only keys they actually define", () => {
    const homeEnv = join(tmp, ".env");
    writeFileSync(homeEnv, "HOME_ONLY=9\n");
    const layers = new EnvLayers(join(tmp, "proj"), homeEnv); // proj has no .env
    expect(layers.get("HOME_ONLY")?.value).toBe("9");
    expect(layers.get("MISSING_KEY")).toBeUndefined();
  });

  it("findSecret scans candidates in order", () => {
    setEnv("OPENAI_API_KEY", "env-key");
    resetEnvLayers();
    const ref = findSecret(["OPENAI_API_KEY", "SOMETHING_ELSE"]);
    expect(ref?.value).toBe("env-key");
    expect(ref?.source).toBe("process");
  });
});

describe("keyring", () => {
  const openai = providerById("openai")!;

  it("stores, lists masked, and removes a key", () => {
    expect(hasKey(openai)).toBe(false);
    setKey(openai, "sk-secret12345");
    expect(hasKey(openai)).toBe(true);
    expect(readKeyring().get("JAA_OPENAI_API_KEY")).toBe("sk-secret12345");

    const meta = listKeyMeta();
    expect(meta.some((m) => m.provider === "openai")).toBe(true);
    const mine = meta.find((m) => m.provider === "openai")!;
    expect(mine.masked).toBe(maskSecret("sk-secret12345"));
    expect(mine.masked).not.toContain("secret");

    expect(removeKey(openai)).toBe(true);
    expect(hasKey(openai)).toBe(false);
    expect(removeKey(openai)).toBe(false);
  });

  it("persists across reads without corrupting unrelated lines", () => {
    setKey(openai, "one");
    setKey(providerById("anthropic")!, "two");
    expect(readKeyring().get("JAA_OPENAI_API_KEY")).toBe("one");
    expect(readKeyring().get("JAA_ANTHROPIC_API_KEY")).toBe("two");
    removeKey(openai);
    expect(readKeyring().get("JAA_OPENAI_API_KEY")).toBeUndefined();
    expect(readKeyring().get("JAA_ANTHROPIC_API_KEY")).toBe("two");
  });

  it("restricts file permissions on POSIX", () => {
    setKey(openai, "sk-x");
    const file = join(tmp, ".env");
    expect(existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("masks short and long secrets safely", () => {
    expect(maskSecret("ab")).toBe("****");
    expect(maskSecret("sk-abcdef")).toBe("****cdef");
  });
});

describe("settings", () => {
  it("loads defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual(defaultSettings());
  });

  it("saves and reloads settings, keeping secrets out of config.json", () => {
    const s = defaultSettings();
    s.defaultProvider = "ollama";
    s.models = { coder: "deepseek-coder" };
    saveSettings(s);
    const reloaded = loadSettings();
    expect(reloaded.defaultProvider).toBe("ollama");
    expect(reloaded.models.coder).toBe("deepseek-coder");
    const raw = readFileSync(join(tmp, "config.json"), "utf8");
    expect(raw.toLowerCase()).not.toContain("key");
  });

  it("gets and sets dotted paths with validation", () => {
    expect(getSetting("defaultProvider").found).toBe(false);
    setSetting("defaultProvider", "openai");
    expect(getSetting("defaultProvider")).toEqual({ found: true, value: "openai" });
    setSetting("models.fast", "gpt-4o-mini");
    expect(getSetting("models.fast")).toEqual({ found: true, value: "gpt-4o-mini" });
    expect(() => setSetting("ollamaBaseUrl", "not-a-url")).toThrow();
    expect(() => setSetting("nope", "1")).toThrow(/no config key/);
  });
});

describe("setup", () => {
  it("stores key + default provider non-interactively", async () => {
    const result = await runSetup({ provider: "openai", key: "sk-secret", nonInteractive: true });
    expect(result.provider).toBe("openai");
    expect(result.keyStored).toBe(true);
    expect(result.defaultProviderSet).toBe(true);
    expect(hasKey(providerById("openai")!)).toBe(true);
    expect(loadSettings().defaultProvider).toBe("openai");
  });

  it("rejects unknown providers", async () => {
    await expect(runSetup({ provider: "nope", key: "x", nonInteractive: true })).rejects.toThrow(
      /unknown provider/,
    );
  });
});