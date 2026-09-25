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
import {
  loadSkills, matchSkills, skillContext,
  installFromGitHub, installFromUrl, listSkillIds, removeSkill,
} from "../skills/index.js";
import { loadAgents } from "../agents/index.js";
import { McpClient, allMcpTools, executeMcpTool } from "../mcp/index.js";
import type { ResolvedModel } from "../providers/types.js";
import type { ToolExecutor } from "../agent/loop.js";

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
  .option("--no-skills", "disable skill autotrigger injection")
  .option("--mcp-server <command...>", "connect to MCP server(s) for extra tools")
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

    const executeTool = async (call: ToolCall) => {
      if (builtInNames.has(call.name)) {
        return registry.execute(call.name, call.arguments, toolContext);
      }
      if (mcpClients.length > 0) {
        return executeMcpTool(mcpClients, call);
      }
      return `unknown tool "${call.name}"`;
    };

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
  .action(async (name: string, task: string | undefined, opts: {
    provider?: string;
    model?: string;
    system?: string;
    maxTurns?: number;
    tokenBudget?: number;
    temperature?: number;
    ctx?: number;
    tools?: boolean;
  }) => {
    const { projectContext, subagents } = loadAgents();
    const spec = subagents.find((a) => a.name === name);
    if (!spec) throw new Error(`subagent "${name}" not found in AGENTS.md`);

    const taskText = task ?? "";
    if (!taskText) throw new Error("provide a task: the positional argument");

    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;

    const { runSubagent } = await import("../agents/runner.js");
    const result = await runSubagent(
      { projectContext, subagents },
      spec,
      {
        task: taskText,
        ...(opts.system !== undefined ? { prompt: opts.system } : {}),
        model: modelInput,
        tools: opts.tools !== false,
        allowBash: opts.tools !== false,
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

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

if (program.args.length === 0 && !process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  program.help();
}