#!/usr/bin/env node
import { Command } from "commander";
import { getPkgInfo } from "../version.js";
import { formatReport, runDoctor } from "../doctor.js";
import { ensureJaaHome } from "../config/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { defaultSettings, getSetting, loadSettings, saveSettings, setSetting, settingsLoadIssue } from "../config/settings.js";
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
import {
  loadSkills, matchSkills, skillContext,
  installFromGitHub, installFromUrl, listSkillIds, removeSkill,
} from "../skills/index.js";
import { loadAgents } from "../agents/index.js";
import { McpClient, allMcpTools, executeMcpTool } from "../mcp/index.js";
import type { ResolvedModel } from "../providers/types.js";
import type { ToolExecutor } from "../agent/loop.js";
import type { HookHandler, ValidatedHookEntry } from "../hooks/types.js";

const pkg = getPkgInfo();

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive integer, got "${value}"`);
  return n;
}

/**
 * A turn index as a positional argument. 0 is a legal target (rewind to before
 * the first turn), so this cannot reuse `parsePositiveInt`, and `Number` rather
 * than `parseInt` so "2.5" is rejected instead of silently becoming turn 2.
 */
function parseTurnIndex(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a turn index (a whole number of 0 or more), got "${value}"`);
  return n;
}

/**
 * Confirm something that destroys work, before it is destroyed.
 *
 * Same shape as `askOnTty`: readline on stderr, closed in a `finally` that runs
 * after the answer settles, and a closed or interrupted stdin treated as a
 * refusal. Consent is never inferred from a non-answer, and `--yes` is the only
 * way to skip the question.
 */
async function confirmDestructive(question: string): Promise<void> {
  if (process.stdin.isTTY !== true) {
    throw new Error("refusing to continue without confirmation — this session is non-interactive, so pass --yes if that is intended");
  }
  const { createInterface } = await import("node:readline/promises");
  // The interface must outlive the answer: closing it before the promise settles
  // hangs the CLI forever.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let answer: string;
  try {
    answer = await rl.question(`${question} [y/N]: `);
  } finally {
    rl.close();
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized !== "y" && normalized !== "yes") throw new Error("aborted — nothing was changed");
}

/** What a hook handler would act on: the command, URL, prompt, or server+tool. */
function hookTarget(handler: HookHandler): string {
  switch (handler.kind) {
    case "command":
      return [handler.command, ...(handler.args ?? [])].join(" ");
    case "http":
      return handler.url;
    case "prompt":
    case "agent":
      return handler.prompt;
    case "mcp":
      return `${handler.server} → ${handler.tool}`;
  }
}

/**
 * Re-run a config layer's `hooks` key through the real validator and report what
 * failed.
 *
 * `loadAllHooks` deliberately swallows a layer that does not parse: one typo
 * must not take the whole chain down. That is the right call at run time and
 * the wrong answer to "why is my hook not firing", because a layer that fails
 * to parse contributes no entries and so is simply absent from the listing. The
 * validation is `parseHookConfig` itself, so the messages are the loader's own,
 * not a second opinion; only the file read is repeated.
 */
async function hookConfigErrors(path: string, label: string): Promise<string[]> {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return [`${label}: not valid JSON (${err instanceof Error ? err.message : String(err)})`];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const raw = (parsed as Record<string, unknown>).hooks;
  if (raw === undefined) return [];
  const { parseHookConfig } = await import("../hooks/types.js");
  const result = parseHookConfig(raw);
  if (result.ok) return [];
  return [`${label}: ${result.errors.length} invalid hook entry/entries`, ...result.errors.map((e) => `  ${e}`)];
}

/**
 * The hook entries a run should apply, from every layer the loader trusts.
 *
 * `loadAllHooks` is the real loader and it already owns the merge, so a run asks
 * it rather than re-reading config itself — that is what keeps a run and
 * `jaa hooks list` from disagreeing about what is in force.
 *
 * `trustProjectClaudeSettings` follows the flag and nothing else. A project
 * `.claude/settings.json` lives inside a cloned repository, so the loader only
 * applies it for a caller that has been told the project is trusted. Every
 * command that runs hooks — `jaa hooks list|test`, `jaa ask`, `jaa chat` —
 * exposes the same `--trust-project-settings` opt-in and all of them default to
 * not applying it. There is no prompt and no second mechanism, so a run can
 * never honour a project layer that `jaa hooks list` would not have shown.
 *
 * A layer that fails to parse contributes no entries, and would otherwise take
 * a deny rule with it in silence. That is reported on stderr, in the same shape
 * `bootstrap` uses for a settings file it could not fully load, because a run
 * that quietly dropped a layer is exactly the case the operator cannot see.
 */
async function hooksForRun(cwd: string, trustProjectSettings = false): Promise<ValidatedHookEntry[]> {
  const { loadAllHooks, defaultHookPaths } = await import("../hooks/index.js");
  const paths = defaultHookPaths(cwd);
  const loaded = loadAllHooks({ ...paths, trustProjectClaudeSettings: trustProjectSettings });

  const problems = [
    ...loaded.warnings.map((warning) => `${paths.settingsPath}: ${warning}`),
    ...(await hookConfigErrors(paths.settingsPath, "~/.jaa/config.json")),
  ];
  if (problems.length > 0) {
    process.stderr.write(
      `jaa: warning: a hook layer was dropped, so the hooks in it did not run this turn:\n` +
        problems.map((line) => `  ${line}\n`).join(""),
    );
  }
  return loaded.entries;
}

function bootstrap(): void {
  const paths = ensureJaaHome();
  if (!existsSync(paths.configFile)) {
    saveSettings(defaultSettings());
    return;
  }
  // Force a load so a parse failure is recorded, then report it. A config that
  // fails to parse has been replaced with defaults, so the operator must be
  // told, or a typo silently removes their deny rules. (Reading the issue
  // without loading first would always report "no problem".)
  loadSettings();
  const issue = settingsLoadIssue();
  if (issue) {
    process.stderr.write(
      `jaa: warning: ${issue.path} could not be fully loaded (${issue.message}). ` +
        `Falling back to defaults for the invalid fields; permission rules that survived validation are still in force.\n`,
    );
  }
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
  .action(async () => {
    console.log(formatReport(await runDoctor()));
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
  .option("--no-skills", "disable skill autotrigger injection")
  .option("--mcp-server <command...>", "connect to MCP server(s) for extra tools")
  .option("--permission-mode <mode>", "permission mode: suggest (ask for every non-allowed call), auto-edit, or full-auto")
  .option(
    "--trust-project-settings",
    "apply .claude/settings.json from the working directory (it lives inside the repo, so it is untrusted by default)",
  )
  .option(
    "--no-sandbox",
    "run shell commands without OS-level isolation (required on hosts with no sandbox, e.g. Windows without a container)",
  )
  .option("--allow-network", "let sandboxed shell commands reach the network (off by default)")
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
    skills?: boolean;
    mcpServer?: string[];
    permissionMode?: string;
    sandbox?: boolean;
    allowNetwork?: boolean;
    trustProjectSettings?: boolean;
  }) => {
    const promptText = prompt ?? opts.prompt;
    if (!promptText) throw new Error("provide a prompt: the positional argument or --prompt <text>");
    const settings = loadSettings();
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
      let systemPrompt = opts.system ?? DEFAULT_SYSTEM_PROMPT;
      if (opts.skills !== false) {
        const active = matchSkills(loadSkills(), promptText);
        const ctx = skillContext(active);
        if (ctx) systemPrompt = `${systemPrompt}\n\n${ctx}`;
      }
      messages.push({ role: "system", content: systemPrompt });
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
      // Commander maps `--no-sandbox` to `sandbox: false`. Default is "require":
      // refuse to run rather than run wide, unless the operator explicitly opts out.
      sandboxEnforcement: opts.sandbox === false ? "best-effort" : "require",
      allowNetwork: opts.allowNetwork === true,
    };

    // Optional MCP server connections
    const mcpClients: McpClient[] = [];
    const mcpServers = opts.mcpServer ?? [];
    if (mcpServers.length > 0) {
      for (const spec of mcpServers) {
        const parts = spec.split(/\s+/);
        const cmd = parts[0]!;
        const args = parts.slice(1);
        const client = new McpClient(cmd, args);
        await client.connect();
        mcpClients.push(client);
      }
    }

    const builtInNames = new Set(registry.list().map((t) => t.name));
    const allTools = toolsEnabled ? [...registry.list(), ...allMcpTools(mcpClients)] : undefined;

    const rawExecuteTool = async (call: ToolCall) => {
      if (builtInNames.has(call.name)) {
        return registry.execute(call.name, call.arguments, toolContext);
      }
      if (mcpClients.length > 0) {
        return executeMcpTool(mcpClients, call);
      }
      return `unknown tool "${call.name}"`;
    };

    // Every tool call, built-in or MCP, passes the permission gate first.
    const { resolveEngine, createPermissionGate, isPermissionMode, askOnTty, SessionGrants } =
      await import("../permissions/index.js");
    const overrideMode = opts.permissionMode ?? settings.permissions?.mode;
    if (overrideMode !== undefined && !isPermissionMode(overrideMode)) {
      throw new Error(`unknown permission mode "${overrideMode}" (suggest, auto-edit, full-auto)`);
    }
    const { engine, mode } = resolveEngine({ ...(overrideMode !== undefined ? { mode: overrideMode } : {}) });
    const grants = new SessionGrants();
    const executeTool = createPermissionGate(
      (call) => rawExecuteTool({ id: call.id ?? "call", name: call.name, arguments: call.arguments }),
      engine,
      mode,
      {
        interactive: process.stdin.isTTY === true,
        cwd: toolContext.cwd,
        root: toolContext.root,
        prompt: (request, outcome) => askOnTty(request, outcome, grants),
      },
    );

    const loopOptions: Parameters<typeof runAgentLoop>[0] = {
      model,
      messages,
      executeTool,
    };
    if (allTools && allTools.length > 0) loopOptions.tools = allTools;
    if (opts.maxTurns !== undefined) loopOptions.maxTurns = opts.maxTurns;
    if (opts.tokenBudget !== undefined) loopOptions.tokenBudget = opts.tokenBudget;
    if (opts.temperature !== undefined) loopOptions.temperature = opts.temperature;
    if (opts.ctx !== undefined) loopOptions.numContext = opts.ctx;

    // Phase 13: the loop is the only place a tool call happens, so the hook chain
    // has to be handed to it here. Omitted entirely when no layer declares a
    // hook, which leaves the pre-Phase-13 path byte for byte unchanged. The
    // project layer stays out unless the operator passes the flag, so a cloned
    // repository cannot inject a hook into a run that did not ask for one.
    const hookEntries = await hooksForRun(process.cwd(), opts.trustProjectSettings === true);
    if (hookEntries.length > 0) {
      loopOptions.hooks = {
        entries: hookEntries,
        // The payloads a hook receives have to name the session that is really
        // running, not the loop's `"jaa"` placeholder.
        sessionId: session.id,
        // Reported to hooks so a handler can see the policy its call was gated
        // under, and an `mcp` handler can reach a server `--mcp-server` opened.
        permissionMode: mode,
        mcpClients,
      };
    }

    // Phase 14: a snapshot of the target file before every mutating call, which
    // is what makes `jaa rewind` able to put the tree back. The session is the
    // one this command already owns — created above, or the one it resumed — so
    // the snapshots land in that session's own store and are addressable by its
    // id, and `ctx` confines every path to the root the tool calls are confined
    // to. With no mutating tool call, nothing is written.
    loopOptions.checkpoints = { session, ctx: toolContext };

    const result = await runAgentLoop(loopOptions);

    // Disconnect MCP servers
    for (const client of mcpClients) {
      await client.disconnect().catch(() => {});
    }

    const delta = result.messages.slice(resumed ? resumed.messages.length : messages.length);
    const persisted = resumed || opts.save;
    if (persisted) {
      appendMessages(session, ...delta);
      saveSession(session);
    }

    // Phase 14 retention, at the one place this command ends a run. A run that
    // snapshotted a file has left a `~/.jaa/checkpoints/<id>/` directory behind,
    // and a session the operator is resuming is excluded: they are still in it,
    // so pruning its store from under them is the one case retention must not
    // do. `cleanupSessionCheckpoints` is a no-op for a run that never wrote a
    // file, so this costs nothing when there is nothing to reclaim.
    if (!resumed) {
      const { cleanupSessionCheckpoints } = await import("../checkpoint/create.js");
      cleanupSessionCheckpoints(session);
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
  .option("--no-skills", "disable skill autotrigger injection")
  .option("--permission-mode <mode>", "permission mode: suggest, auto-edit, or full-auto")
  .option(
    "--trust-project-settings",
    "apply .claude/settings.json from the working directory (it lives inside the repo, so it is untrusted by default)",
  )
  .option("--no-sandbox", "run shell commands without OS-level isolation")
  .option("--allow-network", "let sandboxed shell commands reach the network (off by default)")
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
    skills?: boolean;
    mcpServer?: string[];
    permissionMode?: string;
    sandbox?: boolean;
    allowNetwork?: boolean;
    trustProjectSettings?: boolean;
  }) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("`jaa chat` needs an interactive terminal — use `jaa ask <prompt>` for one-shot output");
    }
    const settings = loadSettings();

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
      sandboxEnforcement: opts.sandbox === false ? "best-effort" : "require",
      allowNetwork: opts.allowNetwork === true,
    };
    const rawExecuteTool = (call: ToolCall) => registry.execute(call.name, call.arguments, toolContext);
    // The TUI is the primary interactive surface and must be gated exactly like
    // `jaa ask`. Leaving it ungated made every ungated write a silent allow.
    const { resolveEngine: resolveForChat, createPermissionGate, isPermissionMode: isModeForChat, askOnTty: askForChat, SessionGrants: GrantsForChat } =
      await import("../permissions/index.js");
    const chatMode = opts.permissionMode ?? settings.permissions?.mode;
    if (chatMode !== undefined && !isModeForChat(chatMode)) {
      throw new Error(`unknown permission mode "${chatMode}" (suggest, auto-edit, full-auto)`);
    }
    const chatPolicy = resolveForChat({ ...(chatMode !== undefined ? { mode: chatMode } : {}) });
    const chatGrants = new GrantsForChat();
    const executeTool = createPermissionGate(
      (call) => rawExecuteTool({ id: call.id ?? "call", name: call.name, arguments: call.arguments }),
      chatPolicy.engine,
      chatPolicy.mode,
      {
        interactive: true,
        cwd: toolContext.cwd,
        root: toolContext.root,
        grants: chatGrants,
        prompt: (request, outcome) => askForChat(request, outcome, chatGrants),
      },
    );

    const { startChat } = await import("../tui/app.js");
    const resumeMessages = resumed?.messages ?? [];

    const session =
      resumed ??
      (opts.save ? createSession({ provider: model.provider, model: model.model, messages: resumeMessages }) : undefined) ??
      undefined;

    // Phase 13: the same loader, the same layers and the same opt-in `jaa ask`
    // uses. The TUI is the primary interactive path, so a `PreToolUse` hook that
    // blocks a call in `ask` has to block it here too — otherwise the surface an
    // operator actually uses is the one the hook chain does not reach. Without
    // `--trust-project-settings` a project `.claude/settings.json` is exactly as
    // untrusted here as it is in `ask`.
    const chatHookEntries = await hooksForRun(process.cwd(), opts.trustProjectSettings === true);

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
       // The TUI gates a rewind with these, so it must be given the ones this
       // command actually gated its tool calls with. Left unset it re-reads
       // settings for the mode and guesses `process.cwd()` for the root, which
       // is a second opinion about a decision this command already made.
       toolContext,
       permissionMode: chatPolicy.mode,
       // Phase 13 for the loop the TUI drives. Omitted when no layer declares a
       // hook, which is the same rule `ask` follows, so a host with no hooks
       // gets the loop's no-wiring path. A chat with neither --save nor
       // --resume has no session to name, so the payload keeps the loop's own
       // default rather than a session id that does not exist.
       ...(chatHookEntries.length > 0
         ? {
             hooks: {
               entries: chatHookEntries,
               ...(session ? { sessionId: session.id } : {}),
               // The policy the tool call was actually gated under, so a handler
               // sees the same mode `ask` reports.
               permissionMode: chatPolicy.mode,
             },
           }
         : {}),
       // Phase 14: the same snapshots `ask` takes, into this session's own
       // store, confined to the same root the tool calls are confined to. It
       // needs a session to name a store, so it rides on `--save`/`--resume`
       // exactly as the `/rewind` picker already did.
       ...(session ? { checkpoints: { session, ctx: toolContext } } : {}),
       ...(opts.skills !== false ? { skills: loadSkills() } : {}),
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

    // Phase 14 retention, at the one place a chat ends. The snapshots a chat
    // took live in that session's store for as long as it is on disk, so
    // `startChat` returning is the moment the window can be applied. A resumed
    // session is excluded for the same reason `ask` excludes it: the operator
    // is still in it, and retention must not prune a live session's store.
    if (session && !resumed) {
      const { cleanupSessionCheckpoints } = await import("../checkpoint/create.js");
      cleanupSessionCheckpoints(session);
    }
  });

// --- agent -----------------------------------------------------------------
const agent = program
  .command("agent")
  .description("manage subagents defined in AGENTS.md");

agent
  .command("list")
  .description("list subagents defined in AGENTS.md")
  .action(() => {
    const { subagents } = loadAgents();
    if (subagents.length === 0) {
      console.log("no subagents defined in AGENTS.md");
      return;
    }
    for (const a of subagents) {
      console.log(`${a.name.padEnd(20)} ${a.description}`);
    }
  });

agent
  .command("show")
  .description("show details for a subagent")
  .argument("<name>", "subagent name")
  .action((name: string) => {
    const { subagents } = loadAgents();
    const spec = subagents.find((a) => a.name === name);
    if (!spec) throw new Error(`subagent "${name}" not found in AGENTS.md`);
    console.log(`# Agent: ${spec.name}\n`);
    console.log(`Description:  ${spec.description || "(none)"}`);
    console.log(`Ownership:    ${spec.ownership || "(none)"}`);
    console.log(`Deps:         ${spec.deps || "(none)"}`);
    console.log(`Acceptance:   ${spec.acceptance || "(none)"}`);
    console.log("\n--- Instructions ---\n");
    console.log(spec.instructions || "(none)");
  });

agent
  .command("run")
  .description("run a subagent on a task")
  .argument("<name>", "subagent name (from AGENTS.md)")
  .argument("[task]", "task for the subagent")
  .option("-p, --provider <id>", "provider id")
  .option("-m, --model <model>", "model id")
  .option("--system <prompt>", "override the subagent's system prompt")
  .option("--max-turns <n>", "cap the agent loop at n turns", parsePositiveInt)
  .option("--token-budget <n>", "context budget in estimated tokens", parsePositiveInt)
  .option("--temperature <n>", "sampling temperature", parseFloat)
  .option("--ctx <n>", "context window in tokens (ollama num_ctx)", parsePositiveInt)
  .option("--no-tools", "run without tool access")
  .option("--allow-bash", "let the subagent run shell commands (off by default, and still permission-gated)")
  .option("--no-sandbox", "run shell commands without OS-level isolation (required on hosts with no sandbox)")
  .option("--allow-network", "let sandboxed shell commands reach the network (off by default)")
  .option("--permission-mode <mode>", "permission mode: suggest, auto-edit, or full-auto")
  .action(async (name: string, task: string | undefined, opts: {
    provider?: string;
    model?: string;
    system?: string;
    maxTurns?: number;
    tokenBudget?: number;
    temperature?: number;
    ctx?: number;
    tools?: boolean;
    bash?: boolean;
    sandbox?: boolean;
    network?: boolean;
    permissionMode?: string;
  }) => {
    const { projectContext, subagents } = loadAgents();
    const settings = loadSettings();
    const spec = subagents.find((a) => a.name === name);
    if (!spec) throw new Error(`subagent "${name}" not found in AGENTS.md`);

    const taskText = task ?? "";
    if (!taskText) throw new Error("provide a task: the positional argument");

    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;

    const { runSubagent } = await import("../agents/runner.js");
    const {
      resolveEngine: resolveForAgent,
      createPermissionGate: gateForAgent,
      isPermissionMode: isModeForAgent,
    } = await import("../permissions/index.js");
    const agentMode = opts.permissionMode ?? settings.permissions?.mode;
    if (agentMode !== undefined && !isModeForAgent(agentMode)) {
      throw new Error(`unknown permission mode "${agentMode}" (suggest, auto-edit, full-auto)`);
    }
    const agentPolicy = resolveForAgent({ ...(agentMode !== undefined ? { mode: agentMode } : {}) });
    const result = await runSubagent(
      { projectContext, subagents },
      spec,
      {
        task: taskText,
        ...(opts.system !== undefined ? { prompt: opts.system } : {}),
        model: modelInput,
        tools: opts.tools !== false,
        // A subagent no longer inherits shell access just because tools are on.
        // It must be opted into, and then it is still subject to the gate.
        allowBash: opts.bash === true,
        // Commander maps `--no-sandbox` to `sandbox: false`. Without this a
        // subagent's bash could never run on a host with no OS sandbox, because
        // `require` is unsatisfiable there and the operator had no way to say so.
        sandboxEnforcement: opts.sandbox === false ? "best-effort" : "require",
        allowNetwork: opts.network === true,
        executeTool: (inner) =>
          gateForAgent(
            (call) => inner({ id: call.id ?? "call", name: call.name, arguments: call.arguments }),
            agentPolicy.engine,
            agentPolicy.mode,
            {
              interactive: false,
              cwd: process.cwd(),
              root: process.cwd(),
            },
          ),
        ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.ctx !== undefined ? { numContext: opts.ctx } : {}),
      },
    );

    for (const msg of result.messages) {
      if (msg.role === "assistant" && msg.content) console.log(msg.content);
    }

    console.error(
      `[${result.stopReason}] ${result.turns} turn(s) · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`,
    );
  });

// --- skill ----------------------------------------------------------------
const skill = program
  .command("skill")
  .description("manage installed skills (~/.jaa/skills/<id>/SKILL.md)");

skill
  .command("list")
  .description("list installed skills")
  .action(() => {
    const ids = listSkillIds();
    if (ids.length === 0) {
      console.log("no skills installed — `jaa skill install <owner>/<repo>`");
      return;
    }
    console.log(ids.join("\n"));
  });

skill
  .command("install")
  .description("install a skill from a GitHub repo or a raw SKILL.md URL")
  .argument("<source>", 'GitHub "<owner>/<repo>" or a URL pointing to a raw SKILL.md')
  .action(async (source: string) => {
    let result;
    if (/^https?:\/\//.test(source)) {
      result = await installFromUrl(source);
    } else {
      result = await installFromGitHub(source);
    }
    console.log(`installed skill "${result.id}" at ${result.path}`);
  });

skill
  .command("remove")
  .description("remove an installed skill")
  .argument("<id>", "skill directory name")
  .action((id: string) => {
    const removed = removeSkill(id);
    if (!removed) throw new Error(`skill "${id}" not found`);
    console.log(`removed skill "${id}"`);
  });

// --- mcp ------------------------------------------------------------------
const mcp = program
  .command("mcp")
  .description("MCP (Model Context Protocol) server and client utilities");

mcp
  .command("serve")
  .description("run the jaa MCP server over stdio (exposes jaa's built-in tools)")
  .option("--allow-bash", "allow the bash tool to execute commands (off by default)")
  .action(async (opts: { allowBash?: boolean }) => {
    const { createJaaMcpServer } = await import("../mcp/jaa-server.js");
    const server = createJaaMcpServer(opts.allowBash === true);
    await server.run();
  });

mcp
  .command("inspect")
  .description("connect to an MCP server and list its tools (for debugging)")
  .argument("<command...>", "MCP server command to run")
  .action(async (command: string[]) => {
    const cmd = command[0]!;
    const args = command.slice(1);
    const client = new McpClient(cmd, args);
    await client.connect();
    const tools = client.tools;
    if (tools.length === 0) {
      console.log("no tools advertised");
    } else {
      for (const tool of tools) {
        console.log(`${tool.name.padEnd(20)} ${(tool.description ?? "").slice(0, 60)}`);
      }
    }
    await client.disconnect();
  });

// --- lsp ------------------------------------------------------------------
const lsp = program
  .command("lsp")
  .description("LSP (Language Server Protocol) utilities");

lsp
  .command("diagnose")
  .description("fetch diagnostics for a file from an LSP server")
  .argument("<file>", "file path to diagnose")
  .argument("<command...>", "LSP server command to run")
  .action(async (filePath: string, command: string[]) => {
    const { resolve } = await import("node:path");
    const { pathToFileURL } = await import("node:url");
    const { LspClient } = await import("../lsp/client.js");
    const cmd = command[0]!;
    const args = command.slice(1);
    const uri = pathToFileURL(resolve(filePath)).href;
    const client = new LspClient(cmd, args);
    try {
      await client.connect();
      const result = await client.getDiagnostics(uri);
      if (!result || result.kind === "unchanged" || result.items.length === 0) {
        console.log("no diagnostics");
      } else {
        for (const item of result.items) {
          const sev = item.severity ?? 1;
          const label = sev === 1 ? "ERROR" : sev === 2 ? "WARN" : sev === 3 ? "INFO" : "HINT";
          const pos = item.range?.start;
          if (pos) {
            console.log(`[${label}] ${pos.line + 1}:${pos.character + 1} ${item.message}${item.source ? ` (${item.source})` : ""}`);
          } else {
            console.log(`[${label}] ${item.message}${item.source ? ` (${item.source})` : ""}`);
          }
        }
      }
    } finally {
      await client.disconnect().catch(() => {});
    }
  });

// --- eval ----------------------------------------------------------------
program
  .command("eval")
  .description("run the built-in eval harness (seed tasks + JSON tasks) and print pass@1 / pass@N metrics")
  .option("--provider <id>", "provider id (defaults to settings defaultProvider, then ollama)")
  .option("--model <model>", "model id")
  .option("--tasks <dir>", "directory of JSON task files (default: seed tasks)")
  .option("--retries <n>", "retries per failing task", parsePositiveInt)
  .option("--json", "emit machine-readable JSON to stdout")
  .action(async (opts: { provider?: string; model?: string; tasks?: string; retries?: number; json?: boolean }) => {
    const { runEvalTask, summarize, seedTasks, loadTasks } = await import("../eval/index.js");
    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;
    const model = resolveModel(modelInput);
    const registry = createDefaultRegistry();
    const toolContext: ToolContext = {
      root: process.cwd(),
      cwd: process.cwd(),
      // The eval harness is a measurement tool, not an operator session: it
      // must never execute shell commands, sandboxed or not.
      allowBash: false,
    };
    const executeTool: ToolExecutor = (call: { name: string; arguments: string }) =>
      registry.execute(call.name, call.arguments, toolContext);

    const tasks = opts.tasks ? loadTasks(opts.tasks) : seedTasks;
    if (tasks.length === 0) throw new Error("no eval tasks found");

    const runs: Array<Awaited<ReturnType<typeof runEvalTask>>> = [];
    const evalOptions: { model: ResolvedModel; executeTool: ToolExecutor; retries?: number } = { model, executeTool };
    if (opts.retries !== undefined) evalOptions.retries = opts.retries;
    for (const task of tasks) {
      const run = await runEvalTask(task, evalOptions);
      runs.push(run);
    }
    const summary = summarize(runs);

    if (opts.json) {
      console.log(JSON.stringify({ ...summary, runs }, null, 2));
      return;
    }

    for (const run of runs) {
      const status = run.pass ? "PASS" : "FAIL";
      const checks = run.checks.map((c: { pass: boolean; name: string }) => `${c.pass ? "✓" : "✗"} ${c.name}`).join(", ");
      console.log(`[${status}] ${run.taskId} (turns=${run.turns} retries=${run.retries}) — ${checks}`);
    }
    console.log(
      `pass@1: ${summary.passAt1}/${summary.total} · pass@N: ${summary.passAtN}/${summary.total} · ` +
        `${summary.totalInputTokens} in / ${summary.totalOutputTokens} out · ${summary.totalDurationMs}ms`,
    );
  });

// --- bench ----------------------------------------------------------------
program
  .command("bench")
  .description("run the parity benchmark: the same cases through jaa and any installed reference harnesses")
  .option("--harness <ids>", "comma-separated: jaa, claude, codex, opencode, dsh (default: jaa)")
  .option("--provider <id>", "provider id for the jaa harness (defaults to settings defaultProvider, then ollama)")
  .option("--model <model>", "model id for the jaa harness")
  .option("--tags <list>", "comma-separated tags to include (default: all)")
  .option("--limit <n>", "stop after n cases per harness (a spend guard)", parsePositiveInt)
  .option("--timeout <ms>", "per-case timeout in milliseconds", parsePositiveInt)
  .option("--out <file>", "NDJSON results file; also enables resume (already-recorded cases are skipped)")
  .option("--report <file>", "write a Markdown report to this path")
  .option("--list", "list the available cases and exit")
  .option("--json", "emit the report as JSON instead of a table")
  .option("--allow-bash", "let the jaa harness run shell commands (off by default)")
  .action(
    async (opts: {
      harness?: string;
      provider?: string;
      model?: string;
      tags?: string;
      timeout?: number;
      limit?: number;
      out?: string;
      report?: string;
      list?: boolean;
      json?: boolean;
      allowBash?: boolean;
    }) => {
      const {
        benchCases,
        caseByTag,
        buildReport,
        toMarkdown,
        runMatrix,
        jaaHarness,
        externalHarness,
        BENCH_TAGS,
      } = await import("../bench/index.js");

      if (opts.list) {
        for (const c of benchCases) {
          console.log(`${c.id.padEnd(28)} ${c.tags.join(",")}`);
        }
        console.log(`\n${benchCases.length} cases across ${BENCH_TAGS.length} tags`);
        return;
      }

      const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
      let cases = caseByTag(tags);
      if (cases.length === 0) throw new Error(`no benchmark cases match tags: ${tags.join(",")}`);
      if (opts.limit !== undefined && cases.length > opts.limit) {
        console.error(`spend guard: limiting to ${opts.limit} of ${cases.length} cases`);
        cases = cases.slice(0, opts.limit);
      }

      const requested = (opts.harness ?? "jaa")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

      const { defaultExternalTemplates } = await import("../bench/harnesses/cli.js");
      const adapters = [];
      // Record the model actually in use, not the literal flag value, so a
      // report row is never labelled "default" when a real model was chosen.
      let modelLabel = opts.model ?? "default";
      for (const id of requested) {
        if (id === "jaa") {
          const modelInput: { provider?: string; model?: string } = {};
          if (opts.provider !== undefined) modelInput.provider = opts.provider;
          if (opts.model !== undefined) modelInput.model = opts.model;
          const resolved = resolveModel(modelInput);
          modelLabel = `${resolved.provider}/${resolved.model}`;
          adapters.push(jaaHarness(resolved, { allowBash: opts.allowBash === true }));
          continue;
        }
        const preset = defaultExternalTemplates[id];
        if (!preset) {
          throw new Error(
            `unknown harness "${id}" (known: ${["jaa", ...Object.keys(defaultExternalTemplates)].join(", ")})`,
          );
        }
        adapters.push(externalHarness({ id, bin: preset.bin, args: preset.args }));
      }

      const matrixOptions: Parameters<typeof runMatrix>[2] = {
        model: modelLabel,
      };
      if (opts.timeout !== undefined) matrixOptions.timeoutMs = opts.timeout;
      if (opts.out !== undefined) matrixOptions.resumeFrom = opts.out;
      if (!opts.json) {
        matrixOptions.onResult = (r) => {
          if (r.skipped) {
            console.error(`[SKIP] ${r.harness} ${r.caseId} - ${r.skipReason}`);
          } else {
            console.error(`[${r.pass ? "PASS" : "FAIL"}] ${r.harness} ${r.caseId}`);
          }
        };
      }

      const results = await runMatrix(cases, adapters, matrixOptions);
      const report = buildReport(results);

      if (opts.report) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(opts.report, toMarkdown(report), "utf8");
        console.error(`report written to ${opts.report}`);
      }

      if (opts.json) {
        console.log(JSON.stringify({ report, results }, null, 2));
        return;
      }

      process.stdout.write(toMarkdown(report));
    },
  );

// --- perm ----------------------------------------------------------------
const perm = program
  .command("perm")
  .description("inspect the effective permission rules and test a tool call against them");

perm
  .command("list")
  .description("print every effective rule, most specific last, with its source")
  .option("--mode <mode>", "permission mode: suggest, auto-edit, full-auto")
  .option("--trust-project-settings", "apply .claude/settings.json from the working directory")
  .action(async (opts: { mode?: string; trustProjectSettings?: boolean }) => {
    const { resolveEngine, describeRule, ruleSpecificity, isPermissionMode } = await import("../permissions/index.js");
    if (opts.mode !== undefined && !isPermissionMode(opts.mode)) {
      throw new Error(`unknown permission mode "${opts.mode}" (suggest, auto-edit, full-auto)`);
    }
    const { mode, rules, projectPolicyFound, projectPolicyApplied } = resolveEngine({
      ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      ...(opts.trustProjectSettings === true ? { trustProjectClaudeSettings: true } : {}),
    });
    console.log(`mode: ${mode}`);
    if (projectPolicyFound) {
      console.log(
        projectPolicyApplied
          ? `project policy: APPLIED from .claude/settings.json (--trust-project-settings)`
          : `project policy: FOUND at .claude/settings.json but NOT applied (it lives inside the repo; pass --trust-project-settings to honour it)`,
      );
    }
    console.log("");
    for (const rule of [...rules].sort((a, b) => ruleSpecificity(a) - ruleSpecificity(b))) {
      console.log(`  [${String(ruleSpecificity(rule)).padStart(4)}] ${describeRule(rule)}`);
    }
    // A rule naming a tool that does not exist can never fire. For a deny that
    // is a silent false sense of security, so say so rather than list it as if
    // it were active.
    const known = new Set<string>([
      "read_file",
      "write_file",
      "list_dir",
      "stat",
      "glob",
      "patch",
      "bash",
      "fetch_url",
      "git_status",
      "git_log",
      "git_diff",
      "git_show",
    ]);
    const inert = rules.filter(
      (r) => r.decision === "deny" && r.tool !== undefined && !r.tool.includes("*") && !known.has(r.tool),
    );
    if (inert.length > 0) {
      console.log("");
      console.log("  WARNING: these deny rules name no known tool and can never fire:");
      for (const r of inert) console.log(`    - tool "${r.tool}" (from ${r.source}). To block a path use { "path": "..." } instead.`);
    }
  });

perm
  .command("test")
  .description("evaluate a tool call against the rules without running it")
  .argument("<tool>", "tool name, e.g. bash")
  .argument(
    "[args]",
    'JSON arguments, e.g. \'{"command":"git status"}\'. Pass "-" or pipe on stdin to avoid shell quoting problems',
  )
  .option("--mode <mode>", "permission mode: suggest, auto-edit, full-auto")
  .action(async (tool: string, argsJson: string | undefined, opts: { mode?: string }) => {
    const { resolveEngine, isPermissionMode, isReadOnlyTool, resolveDecision, describeRule } =
      await import("../permissions/index.js");
    if (opts.mode !== undefined && !isPermissionMode(opts.mode)) {
      throw new Error(`unknown permission mode "${opts.mode}" (suggest, auto-edit, full-auto)`);
    }
    const { engine, mode } = resolveEngine({ ...(opts.mode !== undefined ? { mode: opts.mode } : {}) });

    // Shell quoting mangles JSON containing spaces (notably in PowerShell), so
    // accept the payload on stdin as well as as an argument.
    let raw = argsJson;
    if (raw === undefined && process.stdin.isTTY !== true) {
      const piped = await readStdinIfPiped();
      if (piped) raw = piped;
    } else if (raw === "-") {
      raw = (await readStdinIfPiped()) ?? "";
    }

    let args: Record<string, unknown> = {};
    if (raw !== undefined && raw.trim().length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else throw new Error("expected a JSON object");
      } catch (err) {
        throw new Error(
          `arguments must be a JSON object; got ${raw}. (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    const outcome = engine.evaluate({ tool, args, cwd: process.cwd(), root: process.cwd() });
    // The tool name must be passed: it is what makes bash exempt from the
    // mode's implicit allows.
    const decision = resolveDecision(outcome, mode, isReadOnlyTool(tool), tool);
    console.log(`mode:    ${mode}`);
    console.log(`tool:    ${tool}`);
    console.log(`decision: ${decision}`);
    console.log(`reason:  ${outcome.reason}`);
    if (outcome.rule) console.log(`rule:    ${describeRule(outcome.rule)}`);
    if (decision === "ask") {
      console.log("");
      console.log(
        process.stdin.isTTY
          ? "This would prompt interactively."
          : "This session is non-interactive, so it would be DENIED rather than hang.",
      );
    }
  });

// --- hooks ----------------------------------------------------------------
const hooks = program
  .command("hooks")
  .description("inspect the configured hooks and print a decision trace for one event");

hooks
  .command("list")
  .description("print every hook that would fire, grouped by event")
  .option("--trust-project-settings", "apply .claude/settings.json from the working directory")
  .action(async (opts: { trustProjectSettings?: boolean }) => {
    const { loadAllHooks, defaultHookPaths, HOOK_EVENTS } = await import("../hooks/index.js");
    const { sanitizeForDisplay } = await import("../permissions/index.js");
    const paths = defaultHookPaths(process.cwd());
    const trust = opts.trustProjectSettings === true;
    const loaded = loadAllHooks({ ...paths, ...(trust ? { trustProjectClaudeSettings: true } : {}) });

    // A layer that fails to parse contributes no entries and so is invisible in
    // the listing below. Report what the loader dropped, or a typo in one hook
    // reads as "jaa ignored my config".
    const errors = [
      ...(await hookConfigErrors(paths.settingsPath, "~/.jaa/config.json")),
      ...(trust ? await hookConfigErrors(paths.claudeSettingsPath, ".claude/settings.json") : []),
    ];
    if (errors.length > 0) {
      console.log("config errors (these layers were NOT loaded):");
      for (const line of errors) console.log(`  ${line}`);
      console.log("");
    }

    // A project `.claude/settings.json` lives inside a cloned repository, so it
    // is detected and reported rather than honoured, the same trust gate the
    // permission engine already uses for its rules.
    if (!trust && existsSync(paths.claudeSettingsPath)) {
      console.log(
        "project policy: FOUND at .claude/settings.json but NOT applied (it lives inside the repo; pass --trust-project-settings to honour it)",
      );
      console.log("");
    }

    if (loaded.entries.length === 0) {
      console.log("no hooks configured — add a `hooks` key to ~/.jaa/config.json");
      return;
    }

    const totalGroups = loaded.entries.reduce((total, entry) => total + entry.groups.length, 0);
    console.log(
      `sources: ${loaded.sources.map((s) => `${s.source} ${s.count}`).join(", ")} — ${totalGroups} group(s) across ${loaded.entries.length} event(s)`,
    );
    for (const warning of loaded.warnings) console.log(`  warning: ${warning}`);
    console.log("");

    for (const event of HOOK_EVENTS) {
      const groups = loaded.entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups);
      if (groups.length === 0) continue;
      console.log(`${event} (${groups.length} group${groups.length === 1 ? "" : "s"})`);
      for (const [index, group] of groups.entries()) {
        console.log(`  [${index + 1}] matcher: ${group.matcher ?? "*"}   if: ${group.if ?? "(none)"}`);
        for (const handler of group.handlers) {
          console.log(`      ${handler.kind.padEnd(8)} ${sanitizeForDisplay(hookTarget(handler), 200)}`);
        }
      }
      console.log("");
    }
  });

hooks
  .command("test")
  .description("run a synthetic payload through the chain and print the decision trace")
  .argument("<event>", "hook event name (see `jaa hooks list` for the vocabulary)")
  .option("--tool <name>", "tool name in the synthetic payload (default: Bash)")
  .option("--trust-project-settings", "apply .claude/settings.json from the working directory")
  .action(async (event: string, opts: { tool?: string; trustProjectSettings?: boolean }) => {
    const { isHookEvent, HOOK_EVENTS, loadAllHooks, defaultHookPaths, buildPayload, decideFromHooks, matcherField } =
      await import("../hooks/index.js");
    const { sanitizeForDisplay } = await import("../permissions/index.js");

    if (!isHookEvent(event)) {
      throw new Error(`unknown hook event "${event}" (valid: ${HOOK_EVENTS.join(", ")})`);
    }

    const paths = defaultHookPaths(process.cwd());
    const trust = opts.trustProjectSettings === true;
    const loaded = loadAllHooks({ ...paths, ...(trust ? { trustProjectClaudeSettings: true } : {}) });
    const groups = loaded.entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups);

    // The payload is built from the event's own routing field rather than a
    // hand-rolled per-event table, so a matcher written against the real
    // vocabulary is reachable from the synthetic payload too.
    const field = matcherField(event);
    const input: Parameters<typeof buildPayload>[1] = { sessionId: "jaa-hooks-test", cwd: process.cwd() };
    if (field === "toolName") {
      input.toolName = opts.tool ?? "Bash";
      input.toolInput = { command: "rm -rf build" };
      input.toolCallId = "jaa-hooks-test";
      if (event.startsWith("Post")) input.toolResponse = "exit 0";
    } else if (field === "agentType") {
      input.agentId = "jaa-hooks-test";
      input.agentType = "code-reviewer";
    } else {
      if (event === "UserPromptSubmit") input.prompt = "hello from jaa hooks test";
      if (event === "Notification") {
        input.level = "info";
        input.message = "jaa hooks test";
      }
      if (event === "PostCompact") input.compacted = true;
    }
    const payload = buildPayload(event, input);

    console.log(`event:    ${event}`);
    console.log(`session:  ${payload.sessionId}`);
    console.log(`cwd:      ${payload.cwd}`);
    if (payload.toolName !== undefined) console.log(`tool:     ${payload.toolName}`);
    if (payload.toolInput !== undefined) console.log(`input:    ${JSON.stringify(payload.toolInput)}`);
    if (payload.agentType !== undefined) console.log(`agent:    ${payload.agentType}`);
    if (payload.prompt !== undefined) console.log(`prompt:   ${sanitizeForDisplay(payload.prompt, 120)}`);

    if (groups.length === 0) {
      console.log("groups:   0 registered — no hook in any layer fires on this event");
    } else {
      // The real chain, not a re-implementation: matchers, the `if` filter,
      // handler dispatch, timeouts, precedence and the fail-closed rule all
      // come from `decideFromHooks`.
      const chain = await decideFromHooks(event, groups, payload);
      const fired = chain.groups.filter((g) => g.fired).length;
      console.log(`groups:   ${groups.length} registered, ${fired} fired`);
      console.log("");

      chain.groups.forEach((result, index) => {
        const source = groups[index];
        const ifFilter = source?.if ?? "(none)";
        if (!result.fired) {
          console.log(`group ${index + 1}  matcher=${result.matcher}  if=${ifFilter}  NOT FIRED (matcher or \`if\` did not match the payload)`);
          return;
        }
        console.log(`group ${index + 1}  matcher=${result.matcher}  if=${ifFilter}  fired`);
        for (const handler of result.handlers) {
          const status = handler.timedOut ? "TIMEOUT" : handler.ok ? "ok" : "FAILED";
          const error = handler.error !== undefined ? ` — ${sanitizeForDisplay(handler.error, 160)}` : "";
          console.log(
            `  [${handler.index}] ${handler.handler.kind.padEnd(8)} ${sanitizeForDisplay(hookTarget(handler.handler), 60).padEnd(60)} ${status} ${handler.durationMs}ms${error}`,
          );
          const bits: string[] = [];
          if (handler.decision?.decision !== undefined) bits.push(handler.decision.decision);
          if (handler.decision?.reason !== undefined) bits.push(`reason: ${sanitizeForDisplay(handler.decision.reason, 160)}`);
          if (handler.decision?.updatedInput !== undefined) {
            bits.push(`rewrites tool input → ${JSON.stringify(handler.decision.updatedInput)}`);
          }
          if (handler.decision?.additionalContext !== undefined) {
            bits.push(`adds context → ${sanitizeForDisplay(handler.decision.additionalContext, 160)}`);
          }
          if (handler.decision?.systemMessage !== undefined) {
            bits.push(`system message → ${sanitizeForDisplay(handler.decision.systemMessage, 160)}`);
          }
          console.log(`          ${bits.length === 0 ? "decision: (none — no opinion)" : `decision: ${bits.join("; ")}`}`);
        }
        console.log(`  group verdict: ${result.decision ?? "(none)"}`);
        if (result.reason !== undefined) console.log(`  reason:        ${sanitizeForDisplay(result.reason, 200)}`);
        console.log("");
      });

      if (groups.some((group) => group.handlers.some((handler) => handler.kind === "mcp"))) {
        console.log("note: `jaa hooks test` connects no MCP server, so an mcp hook reports the server as not connected.");
        console.log("");
      }

      console.log(`resolved decision: ${chain.decision ?? "(none — no hook had an opinion; the permission engine's decision stands)"}`);
      if (chain.reason !== undefined) console.log(`  reason:           ${sanitizeForDisplay(chain.reason, 200)}`);
      if (chain.updatedInput !== undefined) console.log(`  rewritten input:  ${JSON.stringify(chain.updatedInput)}`);
      if (chain.additionalContext !== undefined) {
        console.log(`  added context:    ${sanitizeForDisplay(chain.additionalContext, 200)}`);
      }
      if (chain.systemMessage !== undefined) console.log(`  system message:   ${sanitizeForDisplay(chain.systemMessage, 200)}`);
    }
  });

// --- rewind ---------------------------------------------------------------
program
  .command("rewind")
  .description("restore the working tree and/or the conversation to an earlier turn")
  .argument("[turn]", "1-based turn index; omit for the latest turn")
  .option("--session <id>", "session to rewind (default: the most recently updated session)")
  .option("--no-code", "leave the working tree alone (restore the conversation only)")
  .option("--no-conversation", "leave the transcript alone (restore the working tree only)")
  .option("--dry-run", "report what would be restored and change nothing")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (turnText: string | undefined, opts: { session?: string; code?: boolean; conversation?: boolean; dryRun?: boolean; yes?: boolean }) => {
    // Same resolution as `session show`: an explicit id, or the newest session.
    // Picking the newest is only safe because the resolved id is printed and the
    // rewind is confirmed before anything is written.
    const id = opts.session ?? listSessions()[0]?.id;
    if (id === undefined) throw new Error("no sessions yet — run `jaa ask <prompt> --save` first, or pass --session <id>");
    const session = loadSession(id);
    if (!session) throw new Error(`session "${id}" not found`);

    const latest = session.messages.length;
    const turn = turnText === undefined ? latest : parseTurnIndex(turnText);
    if (turn > latest) {
      throw new Error(`turn ${turn} is out of range for session ${session.id} (${latest} messages)`);
    }

    const code = opts.code !== false;
    const conversation = opts.conversation !== false;
    const scope = [code ? "working tree" : null, conversation ? "conversation" : null].filter((s) => s !== null).join(" + ");
    // A dry run destroys nothing, so it is not the thing that needs consent.
    const dryRun = opts.dryRun === true;

    if (opts.yes !== true && !dryRun) {
      await confirmDestructive(
        `rewind session ${session.id} to turn ${turn} of ${latest} (${scope}) — everything after that turn is discarded. Continue?`,
      );
    }

    const { restoreFilesToTurn, restoreMessagesToTurn } = await import("../checkpoint/restore.js");
    // Restore writes, so it needs a root to be confined to and must never reach
    // a shell: `confinePath` refuses any snapshot path outside the workspace.
    const ctx: ToolContext = { root: process.cwd(), cwd: process.cwd(), allowBash: false };
    const errors: string[] = [];

    console.log(`session: ${session.id}`);
    console.log(`turn:    ${turn} of ${latest}`);
    if (dryRun) console.log("mode:    dry run — nothing is written");

    if (code) {
      // `reportOnly` is what makes a preview safe: the plan is computed in full —
      // every selected snapshot read, validated and confined — and only the two
      // filesystem writes are withheld, so the report cannot name a file that a
      // real rewind would refuse.
      const files = restoreFilesToTurn(session, turn, ctx, { reportOnly: dryRun });
      errors.push(...files.errors);
      console.log(`${dryRun ? "would restore" : "restored"} ${files.restored.length} file(s):`);
      for (const file of files.restored) {
        console.log(`  ${file.filePath} (turn ${file.turn}, ${file.toolCallId})`);
      }
      console.log(`skipped ${files.skipped.length} snapshot(s) — not applied for this turn:`);
      for (const file of files.skipped) {
        console.log(`  ${file.filePath} (turn ${file.turn}, ${file.toolCallId})`);
      }
    } else {
      console.log("working tree: untouched");
    }

    if (conversation) {
      const messages = restoreMessagesToTurn(session, turn, { preserveCurrent: dryRun });
      errors.push(...messages.errors);
      console.log(`conversation: kept ${messages.restored.length} message(s), dropped ${messages.skipped.length}`);
    } else {
      console.log("conversation: untouched");
    }

    if (errors.length > 0) {
      for (const error of errors) console.error(`jaa: ${error}`);
      // Partial failure: files may already have been written, so this is not
      // thrown, but a script must still be able to see that it did not all work.
      process.exitCode = 1;
    }
  });

// --- fork -----------------------------------------------------------------
program
  .command("fork")
  .description("branch a session from a turn into a new session id")
  .argument("<id>", "source session id")
  .argument("[turn]", "1-based turn index to branch from; omit to copy the whole transcript")
  .option("--restore", "also rewind the working tree to that turn (discards later edits)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(async (id: string, turnText: string | undefined, opts: { restore?: boolean; yes?: boolean }) => {
    const session = loadSession(id);
    if (!session) throw new Error(`session "${id}" not found`);

    const turn = turnText === undefined ? undefined : parseTurnIndex(turnText);
    if (turn !== undefined && turn > session.messages.length) {
      throw new Error(`turn ${turn} is out of range for session ${session.id} (${session.messages.length} messages)`);
    }

    // A plain fork only writes a new session file, so it discards nothing and
    // needs no prompt. `--restore` rewinds the shared working tree in place,
    // which does destroy the operator's uncommitted work.
    if (opts.restore === true) {
      if (turn === undefined) {
        throw new Error(`--restore needs a turn to rewind to: \`jaa fork ${id} <turn> --restore\``);
      }
      if (opts.yes !== true) {
        await confirmDestructive(
          `fork session ${session.id} at turn ${turn} and rewind the working tree of ${process.cwd()} to it — later edits are discarded. Continue?`,
        );
      }
    }

    const { forkAndRestore, forkSession } = await import("../checkpoint/fork.js");
    const ctx: ToolContext = { root: process.cwd(), cwd: process.cwd(), allowBash: false };
    const options = turn === undefined ? {} : { targetTurn: turn };
    // `forkSession` branches the transcript only; `forkAndRestore` also rewinds
    // the working tree, leaving the source session's own transcript intact.
    const result = opts.restore === true ? forkAndRestore(session, ctx, options) : forkSession(session, options);

    console.log(`forked session ${session.id}${turn === undefined ? "" : ` at turn ${turn}`} into ${result.forkedSession.id}`);
    console.log(`source: ${session.id}${turn === undefined ? " (whole transcript)" : ` at turn ${turn}`} → ${result.forkedSession.id}`);
    if (opts.restore === true) {
      console.log(`working tree: ${result.restored ? "rewound" : "NOT rewound (see the errors below)"}`);
    }
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`jaa: ${error}`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

if (program.args.length === 0 && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  program.help();
}