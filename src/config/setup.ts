import { createInterface } from "node:readline/promises";
import { stdout } from "node:process";
import { providerById, PROVIDERS } from "./providers.js";
import { setKey } from "./keyring.js";
import { loadSettings, saveSettings } from "./settings.js";
import { readStdinIfPiped } from "../utils/cli.js";

export interface SetupOptions {
  provider?: string | undefined;
  key?: string | undefined;
  nonInteractive?: boolean | undefined;
}

export interface SetupResult {
  provider: string;
  keyStored: boolean;
  defaultProviderSet: boolean;
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: stdout });
  return rl.question(question).finally(() => rl.close());
}

function pickProvider(provider?: string): Promise<string> {
  if (provider) {
    if (!providerById(provider)) throw new Error(`unknown provider "${provider}"`);
    return Promise.resolve(provider);
  }
  const lines = PROVIDERS.map((p, i) => `  ${i + 1}. ${p.label} (${p.id})`).join("\n");
  return (async () => {
    const answer = await prompt(`Select a provider:\n${lines}\nprovider> `);
    const idx = Number.parseInt(answer.trim(), 10);
    if (Number.isFinite(idx) && idx >= 1 && idx <= PROVIDERS.length) {
      return PROVIDERS[idx - 1]!.id;
    }
    if (providerById(answer.trim())) return answer.trim();
    throw new Error(`unknown provider "${answer.trim()}"`);
  })();
}

/**
 * One-command setup. Interactive when run on a TTY; pass `--provider --key`
 * (or pipe the key on stdin) for scripted/silent use.
 */
export async function runSetup(opts: SetupOptions): Promise<SetupResult> {
  const id = await pickProvider(opts.provider);
  const def = providerById(id);
  if (!def) throw new Error(`unknown provider "${id}"`);

  let key: string | undefined = opts.key;
  if (!key) key = await readStdinIfPiped();
  if (!key && !def.localOnly) {
    if (opts.nonInteractive) throw new Error("missing --key for non-interactive setup");
    key = (await prompt(`Paste your ${def.label} API key and press Enter> `)).trim();
  }

  let keyStored = false;
  if (key && !def.localOnly) {
    setKey(def, key);
    keyStored = true;
  }

  const settings = loadSettings();
  settings.defaultProvider = id;
  saveSettings(settings);

  return { provider: id, keyStored, defaultProviderSet: true };
}