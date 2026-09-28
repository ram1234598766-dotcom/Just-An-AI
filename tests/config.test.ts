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

  it("leaves every line it did not write byte-for-byte alone", () => {
    // A hand-written keyring. `GITHUB_TOKEN` is not a key jaa wrote and never
    // will be — it is the user's own line, in a file that happens to be shared.
    const file = join(tmp, ".env");
    const original = [
      "# keep this: my own notes",
      "",
      "GITHUB_TOKEN=keepme",
      "JAA_OPENAI_API_KEY=already-set",
      "",
      "# trailing comment",
      "",
    ].join("\n");
    writeFileSync(file, original, "utf8");

    setKey(openai, "replaced");
    const afterSet = readFileSync(file, "utf8");
    expect(afterSet).toContain("GITHUB_TOKEN=keepme");
    expect(afterSet).toContain("# keep this: my own notes");
    expect(afterSet).toContain("# trailing comment");
    expect(afterSet).toContain("JAA_OPENAI_API_KEY=replaced");
    // The value was replaced IN PLACE: same line, not a new one at the end.
    expect(afterSet.indexOf("JAA_OPENAI_API_KEY=replaced")).toBe(original.indexOf("JAA_OPENAI_API_KEY=already-set"));

    setKey(providerById("anthropic")!, "added");
    const afterAppend = readFileSync(file, "utf8");
    expect(afterAppend).toContain("GITHUB_TOKEN=keepme");
    expect(afterAppend).toContain("# keep this: my own notes");
    expect(afterAppend.endsWith("JAA_ANTHROPIC_API_KEY=added\n")).toBe(true);

    expect(removeKey(providerById("anthropic")!)).toBe(true);
    const afterRemove = readFileSync(file, "utf8");
    expect(afterRemove).toContain("GITHUB_TOKEN=keepme");
    expect(afterRemove).toContain("# keep this: my own notes");
    expect(afterRemove).toContain("# trailing comment");
    expect(afterRemove).not.toContain("JAA_ANTHROPIC_API_KEY");
  });

  it("preserves CRLF line endings and a missing final newline", () => {
    const file = join(tmp, ".env");
    writeFileSync(file, "# windows notepad\r\nGITHUB_TOKEN=keepme\r\n", "utf8");
    setKey(openai, "x");
    const after = readFileSync(file, "utf8");
    expect(after).toBe("# windows notepad\r\nGITHUB_TOKEN=keepme\r\nJAA_OPENAI_API_KEY=x\n");

    writeFileSync(file, "GITHUB_TOKEN=keepme", "utf8"); // no trailing newline
    setKey(providerById("anthropic")!, "y");
    expect(readFileSync(file, "utf8")).toBe("GITHUB_TOKEN=keepme\nJAA_ANTHROPIC_API_KEY=y");
  });

  it("removes every copy of a duplicated key, so removed means removed", () => {
    const file = join(tmp, ".env");
    writeFileSync(file, "JAA_OPENAI_API_KEY=one\nGITHUB_TOKEN=keepme\nJAA_OPENAI_API_KEY=two\n", "utf8");
    // readKeyring reports the last write, so that is the value a caller believes
    // is stored; deleting only that one would leave the other still live.
    expect(readKeyring().get("JAA_OPENAI_API_KEY")).toBe("two");
    expect(removeKey(openai)).toBe(true);
    expect(readKeyring().has("JAA_OPENAI_API_KEY")).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("GITHUB_TOKEN=keepme\n");
  });

  it("reports a GitHub token under the id it is stored as", () => {
    // Not a provider key, but it lives in the keyring and `jaa key list` is the
    // only place a user can find out it was saved.
    const github = {
      id: "github",
      label: "GitHub",
      envKeys: [],
      keyringEnv: "JAA_GITHUB_TOKEN",
    };
    setKey(github, "ghp_something");
    const meta = listKeyMeta();
    const mine = meta.find((m) => m.id === "JAA_GITHUB_TOKEN");
    expect(mine, `not listed: ${JSON.stringify(meta)}`).toBeDefined();
    expect(mine?.provider).toBe("github");
    expect(mine?.masked).toBe(maskSecret("ghp_something"));
  });

  it("keeps the existing _API_KEY mapping exactly", () => {
    setKey(providerById("azure")!, "z");
    setKey(openai, "o");
    // A compound id must survive intact rather than collapsing to its last
    // segment: the old `_API_KEY`-only regex kept `azure`, and the `_TOKEN`
    // branch has to keep doing the same.
    setKey({ id: "my_vendor", label: "v", envKeys: [], keyringEnv: "JAA_MY_VENDOR_API_KEY" }, "v");
    const providers = listKeyMeta().map((m) => m.provider);
    expect(providers).toContain("azure");
    expect(providers).toContain("openai");
    expect(providers).toContain("my_vendor");
    // Nothing may come back still wearing its own suffix.
    for (const p of providers) expect(p.endsWith("_api_key") || p.endsWith("_token")).toBe(false);
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