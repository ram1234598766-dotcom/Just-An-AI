#!/usr/bin/env node
import { Command } from "commander";
import { getPkgInfo } from "../version.js";
import { formatReport, runDoctor } from "../doctor.js";
import { ensureJaaHome } from "../config/paths.js";
import { existsSync } from "node:fs";
import { defaultSettings, getSetting, loadSettings, saveSettings, setSetting } from "../config/settings.js";
import { listKeyMeta, maskSecret, removeKey, setKey } from "../config/keyring.js";
import { providerById, PROVIDERS } from "../config/providers.js";
import { envLayers } from "../config/env.js";
import { runSetup } from "../config/setup.js";
import { readStdinIfPiped } from "../utils/cli.js";

const pkg = getPkgInfo();

function bootstrap(): void {
  const paths = ensureJaaHome();
  if (!existsSync(paths.configFile)) saveSettings(defaultSettings());
}

bootstrap();

const program = new Command();

program
  .name("jaa")
  .description(
    "J.A.A. — local-first, multi-provider terminal coding agent. " +
      "Bring your own key from any provider, or run fully local on Ollama.",
  )
  .version(pkg.version, "-v, --version", "print the jaa version")
  .showHelpAfterError();

program
  .command("doctor")
  .description("run environment diagnostics and print a report")
  .action(() => {
    console.log(formatReport(runDoctor()));
  });

// --- key -----------------------------------------------------------------
const key = program
  .command("key")
  .alias("keys")
  .description("manage API keys (stored in ~/.jaa/.env, restricted perms)");

key
  .command("set")
  .description("store an API key for a provider")
  .argument("<provider>", "provider id (openai, anthropic, google, groq, deepseek, mistral, together, xai, azure)")
  .argument("[key]", "API key; if omitted, read from piped stdin")
  .action(async (provider: string, keyValue: string | undefined) => {
    const def = providerById(provider);
    if (!def) throw new Error(`unknown provider "${provider}" (see \`jaa key list --help\` or \`jaa setup\`)`);
    if (def.localOnly) throw new Error(`"${provider}" is local-only and needs no key`);
    const value = keyValue ?? (await readStdinIfPiped()) ?? "";
    if (!value) throw new Error(`no key provided for "${provider}" — pass it as an argument or pipe it on stdin`);
    setKey(def, value);
    console.log(`key stored for ${provider} (${maskSecret(value)}) in ~/.jaa/.env`);
  });

key
  .command("list")
  .description("list configured providers without revealing keys")
  .action(() => {
    const ring = new Map(listKeyMeta().map((m) => [m.provider, m]));
    const layers = envLayers();
    const rows: string[] = [];
    for (const p of PROVIDERS) {
      if (p.localOnly) {
        rows.push(`${p.id.padEnd(14)} local (no key needed)`);
        continue;
      }
      const fromRing = ring.get(p.id);
      const envRef = p.envKeys.map((k) => layers.get(k)).find((r) => r);
      if (fromRing) {
        rows.push(`${p.id.padEnd(14)} keyring  ${fromRing.masked}`);
      } else if (envRef) {
        rows.push(`${p.id.padEnd(14)} ${envRef.source.padEnd(7)} ${maskSecret(envRef.value)}`);
      } else {
        rows.push(`${p.id.padEnd(14)} —`);
      }
    }
    console.log(rows.join("\n"));
  });

key
  .command("remove")
  .description("remove a stored key for a provider")
  .argument("<provider>", "provider id")
  .action((provider: string) => {
    const def = providerById(provider);
    if (!def) throw new Error(`unknown provider "${provider}"`);
    const removed = removeKey(def);
    console.log(removed ? `key removed for ${provider}` : `no key stored for ${provider}`);
  });

// --- config --------------------------------------------------------------
const config = program
  .command("config")
  .description("get/set persistent settings (~/.jaa/config.json; never secrets)")
  .alias("cfg");

config
  .command("list")
  .description("print the effective settings (non-secret)")
  .action(() => {
    console.log(JSON.stringify(loadSettings(), null, 2));
  });

config
  .command("get")
  .argument("<path>", "dotted path, e.g. defaultProvider or ollamaBaseUrl")
  .action((path: string) => {
    const { found, value } = getSetting(path);
    if (!found) throw new Error(`no config key named "${path}"`);
    console.log(typeof value === "string" ? value : JSON.stringify(value));
  });

config
  .command("set")
  .argument("<path>", "dotted path, e.g. defaultProvider or ollamaBaseUrl")
  .argument("<value>", "new value")
  .action((path: string, value: string) => {
    setSetting(path, value);
    console.log(`set ${path}`);
  });

// --- setup ---------------------------------------------------------------
program
  .command("setup")
  .description("one-command provider + key configuration")
  .option("--provider <id>", "provider id (skips the picker)")
  .option("--key <key>", "API key (skips the prompt; omit to pipe on stdin)")
  .option("-y, --yes", "fully non-interactive (requires --provider)")
  .action(async (opts: { provider?: string; key?: string; yes: boolean }) => {
    if (opts.yes && !opts.provider) throw new Error("non-interactive setup requires --provider");
    const result = await runSetup({ provider: opts.provider, key: opts.key, nonInteractive: opts.yes });
    const lines = [
      `provider configured: ${result.provider}`,
      `key stored: ${result.keyStored ? "yes" : "no"}`,
      `default provider: ${result.defaultProviderSet ? result.provider : "unchanged"}`,
    ];
    console.log(lines.join("\n"));
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

if (program.args.length === 0 && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  program.help();
}