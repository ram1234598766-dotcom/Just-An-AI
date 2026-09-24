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
import { DEFAULT_SYSTEM_PROMPT, runAgentLoop } from "../agent/loop.js";
import { appendMessages, createSession, listSessions, loadSession, removeSession, saveSession } from "../agent/session.js";
import { resolveModel } from "../providers/router.js";
import type { ToolCall } from "../providers/types.js";
import { createDefaultRegistry } from "../tools/index.js";
import type { ToolContext } from "../tools/types.js";
import { toJsonAskResult } from "./json.js";

const pkg = getPkgInfo();

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive integer, got "${value}"`);
  return n;
}

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

// --- ask ----------------------------------------------------------------
program
  .command("ask")
  .description("run one agent loop turn (chat, and tools when configured) and print the reply")
  .argument("[prompt]", "what to ask the agent (or pass it with --prompt)")
  .option("-p, --prompt <prompt>", "what to ask the agent (alternative to the positional argument)")
  .option("--provider <id>", "provider id (defaults to settings defaultProvider, then ollama)")
  .option("--model <model>", "model id (defaults to the provider's fast model)")
  .option("--system <prompt>", "system prompt override (defaults to the built-in agent prompt)")
  .option("--max-turns <n>", "cap the agent loop at n turns", parsePositiveInt)
  .option("--token-budget <n>", "context budget in estimated tokens", parsePositiveInt)
  .option("--temperature <n>", "sampling temperature", parseFloat)
  .option("--ctx <n>", "context window in tokens (ollama num_ctx)", parsePositiveInt)
  .option("--resume <id>", "continue an existing session")
  .option("--save", "persist the conversation to a new session")
  .option("--json", "emit machine-readable JSON to stdout instead of prose")
  .option("--no-tools", "run without tool access (plain chat only)")
  .option("--no-bash", "advertise tools but keep the bash shell gated")
  .action(async (prompt: string | undefined, opts: {
    prompt?: string;
    provider?: string;
    model?: string;
    system?: string;
    maxTurns?: number;
    tokenBudget?: number;
    temperature?: number;
    ctx?: number;
    resume?: string;
    save?: boolean;
    json?: boolean;
    tools?: boolean;
    bash?: boolean;
  }) => {
    const promptText = prompt ?? opts.prompt;
    if (!promptText) throw new Error("provide a prompt: the positional argument or --prompt <text>");
    const resumed = opts.resume ? loadSession(opts.resume) : undefined;
    if (opts.resume && !resumed) throw new Error(`session "${opts.resume}" not found`);

    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    else if (resumed?.provider) modelInput.provider = resumed.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;
    else if (resumed?.model) modelInput.model = resumed.model;
    const model = resolveModel(modelInput);
    const messages = resumed ? [...resumed.messages] : [];
    if (messages.length === 0) {
      messages.push({ role: "system", content: opts.system ?? DEFAULT_SYSTEM_PROMPT });
    }
    messages.push({ role: "user", content: promptText });

    const session =
      resumed ??
      createSession({ provider: model.provider, model: model.model, messages: [...messages] });

    const toolsEnabled = opts.tools !== false;
    const registry = createDefaultRegistry();
    const toolContext: ToolContext = {
      root: process.cwd(),
      cwd: process.cwd(),
      allowBash: toolsEnabled && opts.bash !== false,
    };

    const loopOptions: Parameters<typeof runAgentLoop>[0] = {
      model,
      messages,
      executeTool: (call) => registry.execute(call.name, call.arguments, toolContext),
    };
    if (toolsEnabled) loopOptions.tools = registry.list();
    if (opts.maxTurns !== undefined) loopOptions.maxTurns = opts.maxTurns;
    if (opts.tokenBudget !== undefined) loopOptions.tokenBudget = opts.tokenBudget;
    if (opts.temperature !== undefined) loopOptions.temperature = opts.temperature;
    if (opts.ctx !== undefined) loopOptions.numContext = opts.ctx;
    const result = await runAgentLoop(loopOptions);

    const delta = result.messages.slice(resumed ? resumed.messages.length : messages.length);
    const persisted = resumed || opts.save;
    if (persisted) {
      appendMessages(session, ...delta);
      saveSession(session);
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...toJsonAskResult(result, delta, model.provider, model.model), ...(persisted ? { sessionId: session.id } : {}) }));
      return;
    }

    for (const msg of delta) {
      if (msg.role === "assistant" && msg.content) console.log(msg.content);
    }

    console.error(
      `[${result.stopReason}] ${result.turns} turn(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out` +
        (persisted ? ` · session ${session.id}` : ""),
    );
  });

// --- session ------------------------------------------------------------
const session = program
  .command("session")
  .description("manage persisted agent sessions (~/.jaa/sessions)");

session
  .command("list")
  .description("list saved sessions, newest first")
  .action(() => {
    const metas = listSessions();
    if (metas.length === 0) {
      console.log("no sessions yet — run `jaa ask <prompt> --save`");
      return;
    }
    for (const meta of metas) {
      const line = [
        meta.id,
        meta.updatedAt.slice(0, 19).replace("T", " "),
        `${meta.messageCount} msg`,
        meta.model ? `${meta.provider}/${meta.model}` : meta.provider ?? "",
        meta.title ?? "",
      ]
        .filter(Boolean)
        .join("  ");
      console.log(line);
    }
  });

session
  .command("show")
  .description("print a session's full transcript")
  .argument("<id>", "session id")
  .action((id: string) => {
    const found = loadSession(id);
    if (!found) throw new Error(`session "${id}" not found`);
    for (const msg of found.messages) {
      const tag = msg.role;
      console.log(`[${tag}] ${msg.content}`);
      for (const call of msg.toolCalls ?? []) {
        console.log(`[tool-call] ${call.name}(${call.arguments})`);
      }
    }
  });

session
  .command("remove")
  .description("delete a saved session")
  .argument("<id>", "session id")
  .action((id: string) => {
    const removed = removeSession(id);
    if (!removed) throw new Error(`session "${id}" not found`);
    console.log(`removed session ${id}`);
  });

// --- chat ---------------------------------------------------------------
program
  .command("chat")
  .description("interactive terminal chat (Ink TUI); one argument-free session")
  .option("--provider <id>", "provider id (defaults to settings defaultProvider, then ollama)")
  .option("--model <model>", "model id (defaults to the provider's fast model)")
  .option("--system <prompt>", "system prompt override (defaults to the built-in agent prompt)")
  .option("--max-turns <n>", "cap the agent loop at n turns", parsePositiveInt)
  .option("--token-budget <n>", "context budget in estimated tokens", parsePositiveInt)
  .option("--temperature <n>", "sampling temperature", parseFloat)
  .option("--ctx <n>", "context window in tokens (ollama num_ctx)", parsePositiveInt)
  .option("--resume <id>", "continue an existing session")
  .option("--save", "persist the conversation to a new session as you go")
  .option("--no-tools", "run without tool access (plain chat only)")
  .option("--no-bash", "advertise tools but keep the bash shell gated")
  .action(async (opts: {
    provider?: string;
    model?: string;
    system?: string;
    maxTurns?: number;
    tokenBudget?: number;
    temperature?: number;
    ctx?: number;
    resume?: string;
    save?: boolean;
    tools?: boolean;
    bash?: boolean;
  }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("`jaa chat` needs an interactive terminal — use `jaa ask <prompt>` for one-shot output");
    }

    const resumed = opts.resume ? loadSession(opts.resume) : undefined;
    if (opts.resume && !resumed) throw new Error(`session "${opts.resume}" not found`);

    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    else if (resumed?.provider) modelInput.provider = resumed.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;
    else if (resumed?.model) modelInput.model = resumed.model;
    const model = resolveModel(modelInput);

    const toolsEnabled = opts.tools !== false;
    const registry = createDefaultRegistry();
    const toolContext: ToolContext = {
      root: process.cwd(),
      cwd: process.cwd(),
      allowBash: toolsEnabled && opts.bash !== false,
    };
    const executeTool = (call: ToolCall) => registry.execute(call.name, call.arguments, toolContext);

    const { startChat } = await import("../tui/app.js");
    const resumeMessages = resumed?.messages ?? [];

    const session =
      resumed ??
      (opts.save ? createSession({ provider: model.provider, model: model.model, messages: resumeMessages }) : undefined) ??
      undefined;

    await startChat({
      model,
      systemPrompt: opts.system ?? DEFAULT_SYSTEM_PROMPT,
      ...(toolsEnabled ? { tools: registry.list() } : {}),
      executeTool,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.ctx !== undefined ? { numContext: opts.ctx } : {}),
      resumeMessages,
      ...(session ? { sessionId: session.id } : {}),
      onTurnEnd: (result) => {
        if (!session) return;
        const delta = result.messages.slice(session.messages.length);
        if (delta.length === 0) return;
        appendMessages(session, ...delta);
        saveSession(session);
      },
    });

    if (session && session.messages.length > resumeMessages.length) {
      console.error(`conversation saved to session ${session.id}`);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

if (program.args.length === 0 && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  program.help();
}