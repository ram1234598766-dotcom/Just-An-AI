#!/usr/bin/env node
import { Command } from "commander";
import { getPkgInfo } from "../version.js";
import { shouldLaunchTui } from "./tui-default.js";

/**
 * The executor shape the TUI and the loop agree on.
 *
 * Named because two different call sites declare it — the permission gate wraps
 * one, the diagnostics wrapper wraps the other — and an inline structural type in
 * both places is how the two silently drift apart.
 */
type ChatAppExecuteTool = (call: ToolCall) => Promise<string>;
import { formatReport, runDoctor } from "../doctor.js";
import { ensureJaaHome } from "../config/paths.js";
import { existsSync, readFileSync } from "node:fs";
import { defaultSettings, getSetting, loadSettings, saveSettings, setSetting, settingsLoadIssue } from "../config/settings.js";
import { listKeyMeta, maskSecret, removeKey, setKey } from "../config/keyring.js";
import { providerById, PROVIDERS } from "../config/providers.js";
import { envLayers } from "../config/env.js";
import {
  broadScopeWarning,
  GITHUB_CREDENTIAL,
  GITHUB_SHAPE_OVERRIDE_FLAG,
  readGitHubTokenInput,
  reportGitHubToken,
  runSetup,
  setGitHubToken,
} from "../config/setup.js";
import { maskToken } from "../config/redact.js";
import { resolveGitHubAuth } from "../github/auth.js";
import { readStdinIfPiped } from "../utils/cli.js";
import { DEFAULT_SYSTEM_PROMPT, runAgentLoop } from "../agent/loop.js";
import type { CompactionNotice } from "../agent/loop.js";
import { clearMemory, memoryContext, readMemory, remember } from "../agent/memory.js";
import { appendMessages, createSession, listSessions, loadSession, removeSession, saveSession } from "../agent/session.js";
import { resolveModel } from "../providers/router.js";
import type { ToolCall } from "../providers/types.js";
import { createDefaultRegistry, defaultToolDefinitions } from "../tools/index.js";
import { createRegistry } from "../tools/registry.js";
import type { LspManager } from "../lsp/manager.js";
import type { ToolContext } from "../tools/types.js";
import { toJsonAskResult } from "./json.js";
import {
  loadSkills, matchSkills, skillContext,
  installFromGitHub, installFromUrl, listSkillIds, removeSkill,
} from "../skills/index.js";
import { loadAgents } from "../agents/index.js";
import { McpClient, allMcpTools, executeMcpTool } from "../mcp/index.js";
import type { ChatMessage, ResolvedModel } from "../providers/types.js";
import type { ToolExecutor } from "../agent/loop.js";
import type { HookHandler, ValidatedHookEntry } from "../hooks/types.js";
import type { HookSource } from "../hooks/load.js";

const pkg = getPkgInfo();

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive integer, got "${value}"`);
  return n;
}

/**
 * The last assistant message with content in a transcript.
 *
 * A worker's report is its final answer, not its whole transcript: the earlier
 * assistant messages are the tool-call scaffolding, and concatenating them would
 * put a pile of "now I will read the file" narration in front of the result. The
 * `?? ""` matters because a run that ended on `max_turns` can finish with an
 * assistant message that carries only tool calls and no text.
 */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.content.trim() !== "") return message.content;
  }
  return "";
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
 * The one thing `loadAllHooks` cannot report about a layer by itself: a layer
 * whose top level is unreadable.
 *
 * `readJsonHookLayer` returns an empty layer in silence when a file is not JSON
 * — it has nothing about hook config to say, so it leaves the diagnosis here.
 * Everything else it *does* report, through `warnings`: a skipped group, a
 * skipped handler, an event declared with the wrong shape, a `hooks` key that is
 * not an object. So this returns `[]` for all of those, and a line only when the
 * whole file is out.
 *
 * The distinction is the whole reason it exists, because the two states are
 * opposites and need opposite advice. "No hook in this file was loaded" sends an
 * operator hunting for a missing or renamed file. "This group was skipped"
 * sends them to the typo, with every sibling hook in the file still in force —
 * which is what actually happened, since the loader parses group by group and
 * keeps everything that validates.
 *
 * The `hooks`-is-not-an-object branch mirrors `parseHookConfigResilient`'s own
 * condition, minus its absent/null early return, so a `{"hooks": null}` is not
 * reported here either: the loader treats that as "no hooks", and so does this.
 */
function unreadableHookLayer(path: string, label: string): string[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return [
      `${label}: not valid JSON (${err instanceof Error ? err.message : String(err)}) — no hook in this file was loaded`,
    ];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const hooks = (parsed as Record<string, unknown>).hooks;
  if (hooks === undefined || hooks === null) return [];
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    return [
      `${label}: the \`hooks\` key is not an object mapping event names to hook groups — no hook in this file was loaded`,
    ];
  }
  return [];
}

/** Indent every line of a warning, so a multi-line one reads as a single block. */
function indentBlock(text: string, pad = "  "): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}\n`)
    .join("");
}

/**
 * Every hook layer a run or an inspection should honour, split into what loaded
 * and what did not.
 *
 * One loader, one answer: `jaa ask`, `jaa chat`, `jaa agent run`,
 * `jaa hooks list` and `jaa hooks test` all come through here, so no two of them
 * can describe the same config differently — and so a caller cannot print one
 * loader's answer with another's wording.
 *
 * `trustProjectClaudeSettings` follows the flag and nothing else. A project
 * `.claude/settings.json` lives inside a cloned repository, so the loader only
 * applies it for a caller that has been told the project is trusted. Every
 * command that runs hooks — `jaa hooks list|test`, `jaa ask`, `jaa chat`,
 * `jaa agent run` — exposes the same `--trust-project-settings` opt-in and all of
 * them default to not applying it. There is no prompt and no second mechanism,
 * so a run can never honour a project layer that `jaa hooks list` would not have
 * shown.
 */
async function loadHookLayers(
  cwd: string,
  trustProjectSettings: boolean,
): Promise<{
  entries: ValidatedHookEntry[];
  sources: { source: HookSource; count: number }[];
  unreadable: string[];
  skipped: string[];
}> {
  const { loadAllHooks, defaultHookPaths } = await import("../hooks/index.js");
  const paths = defaultHookPaths(cwd);
  const loaded = loadAllHooks({ ...paths, trustProjectClaudeSettings: trustProjectSettings });
  return {
    entries: loaded.entries,
    sources: loaded.sources,
    // A layer that is out entirely: nothing in it ran, and the operator has to
    // fix the file before any of it comes back.
    unreadable: [
      ...unreadableHookLayer(paths.settingsPath, "~/.jaa/config.json"),
      ...(trustProjectSettings ? unreadableHookLayer(paths.claudeSettingsPath, ".claude/settings.json") : []),
    ],
    // A group or handler the validator skipped and named. Its siblings loaded,
    // so this is a mistake in one hook, not an absent config.
    skipped: loaded.warnings,
  };
}

/**
 * The hook entries a run should apply, from every layer the loader trusts.
 *
 * `loadAllHooks` is the real loader and it already owns the merge, so a run asks
 * it rather than re-reading config itself — that is what keeps a run and
 * `jaa hooks list` from disagreeing about what is in force.
 *
 * A layer that is out, or a group inside one that was skipped, contributes no
 * entries — and would otherwise take a deny rule with it in silence. That is
 * reported on stderr, because a run that quietly dropped a hook is exactly the
 * case the operator cannot see.
 */
async function hooksForRun(cwd: string, trustProjectSettings = false): Promise<ValidatedHookEntry[]> {
  const { entries, unreadable, skipped } = await loadHookLayers(cwd, trustProjectSettings);
  // `skipped` already names its own layer — `~/.jaa/config.json:` for a bad
  // group, `AGENTS.md:` for the frontmatter key the parser cannot carry — so
  // prefixing it with the settings path printed an absolute path in front of the
  // layer's own label and read as two different files.
  const problems = [...skipped, ...unreadable];
  if (problems.length > 0) {
    process.stderr.write(
      `jaa: warning: some configured hooks did not run this turn:\n` +
        problems.map((problem) => indentBlock(problem)).join(""),
    );
  }
  return entries;
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
  .argument("<provider>", "provider id (openai, anthropic, google, groq, deepseek, mistral, together, xai, azure, github)")
  .argument("[key]", "API key; if omitted, read from piped stdin. Refused for `github`")
  .option(
    GITHUB_SHAPE_OVERRIDE_FLAG,
    "github only: accept a token whose local format check says `unknown` (skips that check; GitHub still has to accept it)",
  )
  .action(async (provider: string, keyValue: string | undefined, opts: { acceptUnrecognisedShape?: boolean }) => {
    if (provider === GITHUB_CREDENTIAL.id) {
      // Refused, not warned about. A token in argv is readable by every other
      // process on the machine through the process list and is replayed by any
      // later `history`, and the two safe routes cost one extra keystroke.
      if (keyValue !== undefined) {
        throw new Error(
          "refusing to take a GitHub token as a command-line argument: argv is visible to every other process on " +
            "this machine through the process list, and is recorded in your shell history. Pipe it instead " +
            '(`printf %s "$GITHUB_TOKEN" | jaa key set github`), or omit it to be prompted with the input hidden.',
        );
      }
      // A pipe is the safe non-interactive route. With neither, `promptHidden`
      // refuses on a non-TTY rather than falling back to an echoing read.
      const value = await readGitHubTokenInput();
      reportGitHubToken(
        await setGitHubToken(value, {
          ...(opts.acceptUnrecognisedShape === undefined
            ? {}
            : { acceptUnrecognisedShape: opts.acceptUnrecognisedShape }),
        }),
      );
      return;
    }

    const def = providerById(provider);
    if (!def) throw new Error(`unknown provider "${provider}" (see \`jaa key list --help\` or \`jaa setup\`)`);
    if (def.localOnly) throw new Error(`"${provider}" is local-only and needs no key`);
    if (keyValue !== undefined) {
      // Still stored — the positional has been the documented way to set a key
      // for a long time and removing it breaks scripts — but the same argument
      // leak as `github` applies to an API key, so it says so.
      process.stderr.write(
        "jaa: warning: passing a key as a command-line argument puts it in the process list, where any other " +
          "process on this machine can read it, and in your shell history, where a later `history` replays it. " +
          'Pipe it instead (`printf %s "$OPENAI_API_KEY" | jaa key set openai`), or omit it to be prompted with ' +
          "the input hidden.\n",
      );
    }
    const value = keyValue ?? (await readStdinIfPiped()) ?? "";
    if (!value) throw new Error(`no key provided for "${provider}" — pipe it on stdin, or omit it to be prompted`);
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
    // Not a member of PROVIDERS, so the loop above cannot reach it — and going
    // through the resolver rather than the keyring map is the point: the source
    // can be the process environment, a project `.env`, `~/.jaa/.env` or `gh`,
    // and an operator looking at a missing row needs to know which one is in
    // force. `maskToken` is last-four only, the same shape `setGitHubToken`
    // prints, so a token identified in one command is identifiable in the other.
    const gh = resolveGitHubAuth();
    rows.push(
      gh.token === undefined
        ? `${GITHUB_CREDENTIAL.id.padEnd(14)} anonymous  —`
        : `${GITHUB_CREDENTIAL.id.padEnd(14)} ${gh.source.padEnd(9)} ${maskToken(gh.token)}`,
    );
    console.log(rows.join("\n"));
  });

key
  .command("remove")
  .description("remove a stored key for a provider")
  .argument("<provider>", "provider id")
  .action((provider: string) => {
    // `github` is set-able, so it has to be removable: a credential that can be
    // installed and not withdrawn through the same command is a trap.
    const def = provider === GITHUB_CREDENTIAL.id ? GITHUB_CREDENTIAL : providerById(provider);
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
  .option("--key <key>", "API key (skips the prompt; omit to pipe on stdin). Visible in the process list and shell history")
  .option(
    "--github",
    "configure a GitHub token as part of setup (otherwise you are asked once, on a terminal, if none is configured)",
  )
  .option("--skip-github", "do not configure a GitHub token")
  .option(
    GITHUB_SHAPE_OVERRIDE_FLAG,
    "github only: accept a token whose local format check says `unknown` (skips that check; GitHub still has to accept it)",
  )
  .option("-y, --yes", "fully non-interactive (requires --provider)")
  .action(
    async (opts: {
      provider?: string;
      key?: string;
      github?: boolean;
      skipGithub?: boolean;
      acceptUnrecognisedShape?: boolean;
      yes: boolean;
    }) => {
      if (opts.yes && !opts.provider) throw new Error("non-interactive setup requires --provider");
      const result = await runSetup({
        provider: opts.provider,
        key: opts.key,
        nonInteractive: opts.yes,
        github: opts.skipGithub ? false : opts.github,
        acceptUnrecognisedShape: opts.acceptUnrecognisedShape,
      });
      const lines = [
        `provider configured: ${result.provider}`,
        `key stored: ${result.keyStored ? "yes" : "no"}`,
        `default provider: ${result.defaultProviderSet ? result.provider : "unchanged"}`,
      ];
      if (result.github !== undefined) {
        // Same reporting as `jaa key set github`, minus the "stored" line the
        // setup summary already implies.
        lines.push(`github token: verified for ${result.github.login} (${result.github.masked})`);
        lines.push(
          `github scopes: ${
            result.github.scopes.length === 0
              ? "none reported — a fine-grained token grants per-repository permissions instead of OAuth scopes"
              : result.github.scopes.join(", ")
          }`,
        );
        if (result.github.rateLimitRemaining !== undefined) {
          lines.push(`github rate limit: ${String(result.github.rateLimitRemaining)} request(s) left`);
        }
        const warning = broadScopeWarning(result.github.broadScopes);
        if (warning !== undefined) process.stderr.write(`${warning}\n`);
      }
      console.log(lines.join("\n"));
    },
  );

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
  .option("--lsp", "use a language server for code intelligence (default: off; starts a process per language)")
  .option("--no-memory", "do not inject this project's durable auto-memory (JAA-MEMORY.md)")
  .option("--no-compact", "do not summarise the context when it grows past the threshold")
  .option("--compact-threshold <n>", "compact at this fraction of the token budget (0.1-1.0, default 0.9)", Number)
  .option("--compact-keep <n>", "messages preserved verbatim at the tail when compacting", parsePositiveInt)
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
    memory?: boolean;
    compact?: boolean;
    compactThreshold?: number;
    lsp?: boolean;
    compactKeep?: number;
  }) => {
    const promptText = prompt ?? opts.prompt;
    if (!promptText) throw new Error("provide a prompt: the positional argument or --prompt <text>");
    if (
      opts.compactThreshold !== undefined &&
      (!Number.isFinite(opts.compactThreshold) || opts.compactThreshold < 0.1 || opts.compactThreshold > 1)
    ) {
      throw new Error(`--compact-threshold must be between 0.1 and 1.0, got ${opts.compactThreshold}`);
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
    const messages = resumed ? [...resumed.messages] : [];
    if (messages.length === 0) {
      let systemPrompt = opts.system ?? DEFAULT_SYSTEM_PROMPT;
      // Phase 16: durable project notes from previous sessions, below the skills
      // and above the identity, so the model reads what the project taught it
      // before it reads what jaa is. `--no-memory` skips the read; nothing else
      // does, because a memory that only loads sometimes is not memory.
      if (opts.memory !== false) {
        const notes = memoryContext(readMemory(process.cwd()));
        if (notes) systemPrompt = `${systemPrompt}\n\n${notes}`;
      }
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

    // Phase 17: code intelligence. Off unless `--lsp`. The tools go into the
    // registry at construction rather than being added to it, so there is one
    // path by which a tool becomes callable.
    let lspManager: LspManager | undefined;
    if (opts.lsp === true) {
      const { LspManager: Manager } = await import("../lsp/manager.js");
      lspManager = new Manager({ root: process.cwd() });
    }
    const lspToolDefs = lspManager === undefined ? [] : (await import("../tools/lsp.js")).lspTools(() => lspManager);
    const registry =
      lspToolDefs.length === 0
        ? createDefaultRegistry()
        : createRegistry([...defaultToolDefinitions(), ...lspToolDefs]);

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
    // Phase 16: accumulated here so the summary line can report totals across
    // every firing in the run, not just the last.
    const compactionNotices: CompactionNotice[] = [];
    // Phase 17: which files a language server reported problems in, so the run
    // ends with an honest line rather than the model quietly guessing.
    const lspDiagnosticNotices: Array<{ path: string; count: number }> = [];
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

    // Phase 17: after a mutating call, ask the language server what it thinks of
    // the file and put the answer on the tool result. The model never asks for
    // this, which is the point: an agent that hallucinates a type error will
    // "fix" correct code, and the mistake is invisible because it was asserted
    // confidently.
    //
    // It rides on the result rather than becoming a message, for the same reason
    // hook context does — a provider requires every tool result to immediately
    // follow its assistant message, and an inserted message would shift every
    // later position and break the Phase 14 turn index. Because the result is
    // part of `result.messages`, the diagnostics are also what `--save` writes and
    // `jaa session show` replays.
    if (lspManager !== undefined && toolsEnabled) {
      const { withDiagnostics } = await import("../lsp/loop.js");
      // `baseExecute` is already the permission-gated executor built above, so
      // wrapping it does not bypass the gate: the call passes the engine exactly
      // once, and only the result gains text.
      const baseExecute = loopOptions.executeTool;
      loopOptions.executeTool = withDiagnostics(
        baseExecute,
        { manager: lspManager, root: toolContext.root },
        (report) => {
          if (report.text !== "") lspDiagnosticNotices.push({ path: report.path, count: report.count });
        },
      );
    }

    // Phase 16: compaction on the request, never on the saved transcript — see
    // `compact.ts` for why rewriting `history` would invalidate every Phase 14
    // checkpoint position. Omitted when off, which leaves the pre-Phase-16 path
    // unchanged. `onCompaction` is the observability the plan asks for: a
    // summarisation is a provider call that costs tokens, and a user watching
    // their bill should be able to see it happened.
    if (opts.compact !== false) {
      loopOptions.compaction = {
        ...(opts.compactThreshold !== undefined ? { threshold: opts.compactThreshold } : {}),
        ...(opts.compactKeep !== undefined ? { keepRecent: opts.compactKeep } : {}),
      };
      loopOptions.onCompaction = (info) => {
        compactionNotices.push(info);
        console.error(
          `[compacted] context ${info.tokensBefore} → ${info.tokensAfter} tokens ` +
            `(${info.calls} summarising call${info.calls === 1 ? "" : "s"})`,
        );
      };
    }

    const result = await runAgentLoop(loopOptions);

    // Disconnect MCP servers
    for (const client of mcpClients) {
      await client.disconnect().catch(() => {});
    }
    // Phase 17: stop every language server before this process exits. A
    // `typescript-language-server` left running holds a whole project in memory,
    // and there is one per language, so skipping this is the difference between
    // exiting promptly and leaving a machine hot.
    if (lspManager !== undefined) {
      await lspManager.close().catch(() => {});
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
        (persisted ? ` · session ${session.id}` : "") +
        (lspDiagnosticNotices.length > 0
          ? ` · lsp: ${lspDiagnosticNotices.reduce((n, d) => n + d.count, 0)} problem(s) in ` +
            `${new Set(lspDiagnosticNotices.map((d) => d.path)).size} file(s)`
          : ""),
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
  .option(
    "--lsp",
    "check edits with a real language server, and show the compiler's verdict as its own line",
  )
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
    lsp?: boolean;
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
     const gatedExecuteTool: ChatAppExecuteTool = createPermissionGate(
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

     // Phase 17: one diagnostics source for both consumers.
     //
     // `withDiagnostics` appends the compiler's verdict to the tool result, so
     // the model sees it and the saved session records it. The same call also
     // hands the report to a listener, which is what the TUI draws. One source
     // means the two cannot disagree about what the compiler said.
     //
     // A small listener set rather than a callback held in a variable, because
     // the wrapper is built before the TUI exists and the TUI subscribes after
     // it is constructed.
     /**
      * Reports the compiler produced that the TUI has not drawn yet.
      *
      * A queue rather than a callback, because the wrapper is built before the
      * TUI exists: `withDiagnostics` runs during a tool call, and the TUI
      * subscribes when it mounts. A report produced in between has to be
      * somewhere, or it is lost — and a lost diagnostic is the one failure this
      * whole feature exists to prevent.
      */
     const diagnosticsQueue: { text: string; path: string }[] = [];
     const drainDiagnostics = (): { text: string; path: string }[] => diagnosticsQueue.splice(0);
     let chatExecuteTool: ChatAppExecuteTool = gatedExecuteTool;
     if (opts.lsp === true) {
       const { LspManager } = await import("../lsp/manager.js");
       const { detectServers } = await import("../lsp/registry.js");
       const { withDiagnostics } = await import("../lsp/loop.js");
       const detected = detectServers(toolContext.root);
       const manager = new LspManager({ root: toolContext.root, servers: detected.map((d) => d.config) });
       chatExecuteTool = withDiagnostics(gatedExecuteTool, { manager, root: toolContext.root }, (report) => {
         // `text` is the same text `withDiagnostics` appended to the tool result,
         // so the row and the model's copy cannot disagree.
         diagnosticsQueue.push({ text: report.text, path: report.path });
       });
     }

     await startChat({
       model,
       systemPrompt: opts.system ?? DEFAULT_SYSTEM_PROMPT,
       ...(toolsEnabled ? { tools: registry.list() } : {}),
       executeTool: chatExecuteTool,
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
       // Phase 17, for the user's eyes rather than the model's. The diagnostics
       // already reach the model and the saved session on the tool result; this
       // drains what the wrapper collected into rows of their own, so the
       // compiler's verdict cannot be mistaken for the model reporting on its
       // own work. Absent unless `--lsp`, so a chat with no language server
       // behaves exactly as it did.
       ...(opts.lsp === true ? { drainDiagnostics } : {}),
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
  .option("--trust-project-settings", "apply .claude/settings.json from the working directory")
  .option(
    "--alongside <names>",
    "also run these comma-separated subagents in parallel under the thread and depth caps",
  )
  .option("--max-threads <n>", "workers running at once (default 6, ceiling 32)", parsePositiveInt)
  .option("--max-depth <n>", "delegation edges below this task (default 1, ceiling 4)", parsePositiveInt)
  .option("--isolation <kind>", "run each worker in its own git worktree: none or worktree")
  .option("--keep-worktrees", "do not remove the worktrees this run created")
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
    trustProjectSettings?: boolean;
    alongside?: string;
    maxThreads?: number;
    maxDepth?: number;
    isolation?: string;
    keepWorktrees?: boolean;
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

    // Phase 13: the same loader, layers and opt-in trust gate `ask` and `chat`
    // use, through the same `hooksForRun` — so the entries are identical and the
    // operator gets the same stderr report when a configured hook did not run.
    // Without this a `PreToolUse` deny the operator wrote stops at the parent's
    // own tool calls and the subagent walks straight past it — and a subagent is
    // the cheaper thing to run, so it is the one most likely to be reached for.
    // Empty when no layer declares a hook, which keeps this path inert for a host
    // with no hooks.
    const hookEntries = await hooksForRun(process.cwd(), opts.trustProjectSettings === true);

    // Phase 14: snapshots of the subagent's writes need a store to land in, and
    // the store is named by a session id — nothing but `session.id` is read from
    // it. This run owns one for exactly as long as the subagent does. It is never
    // saved, so `jaa session list` shows nothing new, and its store is pruned
    // below.
    const agentSession = createSession();

    // The options every run shares, whether it is one subagent or a pool of
    // them. Built once so `--alongside` and the single-agent path cannot drift
    // apart on permissions, hooks or sandboxing — the difference between them is
    // concurrency, never authority.
    const shared = {
      ...(opts.system !== undefined ? { prompt: opts.system } : {}),
      model: modelInput,
      tools: opts.tools !== false,
      // A subagent no longer inherits shell access just because tools are on.
      // It must be opted into, and then it is still subject to the gate.
      allowBash: opts.bash === true,
      // Commander maps `--no-sandbox` to `sandbox: false`. Without this a
      // subagent's bash could never run on a host with no OS sandbox, because
      // `require` is unsatisfiable there and the operator had no way to say so.
      sandboxEnforcement: opts.sandbox === false ? ("best-effort" as const) : ("require" as const),
      allowNetwork: opts.network === true,
      executeTool: (inner: (call: ToolCall) => Promise<string>) =>
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
      // Only carried when there is something to carry: `runSubagent` omits the
      // loop option entirely for an empty list, so no `SessionStart`/`Stop`
      // round trip happens on a host with no hooks.
      ...(hookEntries.length > 0
        ? { hookEntries, hookSessionId: agentSession.id, permissionMode: agentPolicy.mode }
        : {}),
      checkpointSession: agentSession,
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.ctx !== undefined ? { numContext: opts.ctx } : {}),
    };

    // Phase 15: the parallel path. `--alongside` turns a single subagent run
    // into a fan-out, so it goes through the pool rather than through a second,
    // slightly different copy of this action — the caps, the board, the
    // injection scan and the worktree cleanup are all the pool's job, and a
    // second code path would be a second set of them to keep correct.
    if (opts.alongside !== undefined) {
      const names = opts.alongside
        .split(",")
        .map((n) => n.trim())
        .filter((n) => n !== "");
      if (names.length === 0) throw new Error("--alongside needs at least one subagent name");

      const specs = [spec, ...names.map((other) => {
        const found = subagents.find((a) => a.name === other);
        if (!found) throw new Error(`subagent "${other}" not found in AGENTS.md`);
        return found;
      })];

      const { runPool } = await import("../orchestrator/pool.js");
      const { createDefaultRegistry } = await import("../tools/index.js");
      // The parent session's own reach is the ceiling for every worker, so a
      // declaration can narrow it and nothing can raise it.
      const parentTools = createDefaultRegistry().list().map((tool) => tool.name);

      const pool = await runPool(
        specs.map((workerSpec) => async (context) => {
          context.task.prompt = taskText;
          context.task.agent = workerSpec.name;
          const out = await runSubagent({ projectContext, subagents }, workerSpec, {
            ...shared,
            task: taskText,
            cwd: context.cwd,
          });
          return {
            output: lastAssistantText(out.messages),
            usage: out.usage,
          };
        }),
        {
          // One `limits` object, not two spreads: a second `limits` key would
          // silently discard the first, so `--max-threads` and `--max-depth`
          // together would keep only the depth cap.
          limits: {
            ...(opts.maxThreads !== undefined ? { maxThreads: opts.maxThreads } : {}),
            ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
          },
          isolation: opts.isolation === "worktree" ? "worktree" : "none",
          keepWorktrees: opts.keepWorktrees === true,
          repoRoot: process.cwd(),
          parentTools,
          onEvent: (event) => {
            if (event.type === "isolation-failed") console.error(`jaa: ${event.reason}`);
            if (event.type === "task-failed") console.error(`jaa: ${event.task.id} failed: ${event.error}`);
            if (event.type === "task-refused") console.error(`jaa: ${event.reason}`);
          },
        },
      );

      const { cleanupSessionCheckpoints } = await import("../checkpoint/create.js");
      cleanupSessionCheckpoints(agentSession);

      for (const task of pool.tasks) {
        const name = task.agent ?? task.id;
        if (task.status === "completed") {
          console.log(`\n=== ${name} ===\n${(task.result ?? "").trim()}`);
        } else if (task.status === "failed") {
          console.error(`jaa: ${name} failed: ${task.error ?? "no reason recorded"}`);
        }
      }
      console.error(
        `[pool] ${pool.tasks.length} task(s) · maxThreads ${pool.limits.maxThreads} · ` +
          `maxDepth ${pool.limits.maxDepth} · ${pool.usage.inputTokens} in / ${pool.usage.outputTokens} out`,
      );
      if (pool.tasks.some((task) => task.status === "failed")) process.exitCode = 1;
      return;
    }

    const result = await runSubagent({ projectContext, subagents }, spec, { ...shared, task: taskText });

    // Phase 14 retention, at the one place a subagent run ends. The snapshots it
    // took live in that session's store for as long as it is on disk, so the run
    // returning is the moment the window can be applied — the same rule `ask` and
    // `chat` apply. A no-op when the subagent never wrote a file.
    const { cleanupSessionCheckpoints } = await import("../checkpoint/create.js");
    cleanupSessionCheckpoints(agentSession);

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
  .description("language servers: what this project would use, and whether it is usable");

lsp
  .command("list")
  .description("show which language servers apply to this project")
  .option("--json", "emit the raw detection records")
  .action(async (opts: { json?: boolean }) => {
    const { detectServers, describeDetection } = await import("../lsp/registry.js");
    const detected = detectServers(process.cwd());
    if (opts.json === true) {
      console.log(JSON.stringify(detected, null, 2));
      return;
    }
    if (detected.length === 0) {
      console.log("no language applies to this project — no server would be started");
      return;
    }
    for (const line of describeDetection(detected)) console.log(line);
    const usable = detected.filter((d) => d.available);
    console.log(`\n${usable.length} of ${detected.length} usable. Start jaa with --lsp to use them.`);
  });

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
    const { defaultHookPaths, HOOK_EVENTS } = await import("../hooks/index.js");
    const { sanitizeForDisplay } = await import("../permissions/index.js");
    const trust = opts.trustProjectSettings === true;
    const paths = defaultHookPaths(process.cwd());
    const { entries, sources, unreadable, skipped } = await loadHookLayers(process.cwd(), trust);

    // A layer that is out entirely contributes no entries and so is invisible in
    // the listing below. Report it, or a typo in one hook reads as "jaa ignored
    // my config".
    if (unreadable.length > 0) {
      console.log("config errors (these layers could not be read, so no hook in them was loaded):");
      process.stdout.write(unreadable.map((line) => indentBlock(line)).join(""));
      console.log("");
    }

    // A malformed *group* is a different case and used to be described as this
    // one: the loader skips the group, names it, and loads every sibling beside
    // it, so the layer is live and partially in force. Calling that "NOT loaded"
    // sent an operator to look for a missing file when the fault was one typo in
    // a hook they had written correctly.
    if (skipped.length > 0) {
      console.log("skipped (these hook groups were NOT loaded; every other hook in the same file is in force):");
      process.stdout.write(skipped.map((line) => indentBlock(line)).join(""));
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

    if (entries.length === 0) {
      console.log(
        skipped.length > 0
          ? "no hooks configured — every hook in the layers above was skipped, so none are in force"
          : "no hooks configured — add a `hooks` key to ~/.jaa/config.json",
      );
      return;
    }

    const totalGroups = entries.reduce((total, entry) => total + entry.groups.length, 0);
    console.log(
      `sources: ${sources.map((s) => `${s.source} ${s.count}`).join(", ")} — ${totalGroups} group(s) across ${entries.length} event(s)`,
    );
    console.log("");

    for (const event of HOOK_EVENTS) {
      const groups = entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups);
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
    const { isHookEvent, HOOK_EVENTS, buildPayload, decideFromHooks, matcherField } =
      await import("../hooks/index.js");
    const { sanitizeForDisplay } = await import("../permissions/index.js");

    if (!isHookEvent(event)) {
      throw new Error(`unknown hook event "${event}" (valid: ${HOOK_EVENTS.join(", ")})`);
    }

    const trust = opts.trustProjectSettings === true;
    const { entries, unreadable, skipped } = await loadHookLayers(process.cwd(), trust);
    const groups = entries.filter((entry) => entry.event === event).flatMap((entry) => entry.groups);

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

    // The trace below is built from the entries that loaded, so a group the
    // validator skipped never appears in it. Printing "resolved decision: allow"
    // without saying so is the most misleading thing this command can do: a
    // `PreToolUse` deny rule the operator wrote would be sitting in the config,
    // absent from the chain, and unremarked — and a `test` run is exactly where
    // someone goes to find out whether the rule is live.
    if (unreadable.length > 0) {
      console.log("errors:    these layers could not be read, so no hook in them was loaded:");
      process.stdout.write(unreadable.map((line) => indentBlock(line)).join(""));
      console.log("");
    }
    if (skipped.length > 0) {
      console.log("skipped:   some configured hooks did NOT load, so they did not run:");
      process.stdout.write(skipped.map((line) => indentBlock(line)).join(""));
      console.log("");
    }

    if (groups.length === 0) {
      console.log(
        skipped.length > 0
          ? "groups:   0 registered — every hook for this event was skipped, so none of them fire"
          : "groups:   0 registered — no hook in any layer fires on this event",
      );
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

// --- compact ---------------------------------------------------------------
program
  .command("compact")
  .description("summarise a saved session in place, replacing its early turns with a summary")
  .argument("[session]", "session id; the most recently updated session when omitted")
  .option("--focus <text>", "ask the summary to pay particular attention to something")
  .option("--provider <id>", "provider id for the summarising call")
  .option("--model <model>", "model id for the summarising call")
  .option("--json", "emit the result as JSON")
  .option("--yes", "skip the confirmation")
  .action(async (sessionId: string | undefined, opts: {
    focus?: string;
    provider?: string;
    model?: string;
    json?: boolean;
    yes?: boolean;
  }) => {
    const id = sessionId ?? listSessions()[0]?.id;
    if (id === undefined) throw new Error("no sessions to compact");
    const session = loadSession(id);
    if (session === undefined) throw new Error(`session "${id}" not found`);

    const { compactSession } = await import("../agent/compact.js");
    const { estimateChatTokens } = await import("../agent/budget.js");
    const modelInput: { provider?: string; model?: string } = {};
    if (opts.provider !== undefined) modelInput.provider = opts.provider;
    else if (session.provider !== undefined) modelInput.provider = session.provider;
    if (opts.model !== undefined) modelInput.model = opts.model;
    else if (session.model !== undefined) modelInput.model = session.model;
    const model = resolveModel(modelInput);

    // This rewrites the saved transcript, so the early turns are only in the
    // summary afterwards. The session's own checkpoints are keyed by message
    // position and stop addressing the original layout, which is the same
    // consequence the module documents for the loop — hence the confirmation.
    if (opts.yes !== true && !opts.json) {
      await confirmDestructive(
        `compact session ${id}: ${session.messages.length} messages become a summary, and the early turns are ` +
          `no longer in the file. Its checkpoints will no longer address the original message positions. Continue?`,
      );
    }

    const result = await compactSession(
      session.messages,
      { ...(opts.focus !== undefined ? { focus: opts.focus } : {}), keepRecent: 8 },
      model,
    );

    if (opts.json === true) {
      console.log(
        JSON.stringify(
          {
            session: id,
            compacted: result.compacted,
            reason: result.reason,
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
            calls: result.calls,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (!result.compacted) {
      console.log(`session ${id} was not compacted: ${result.reason ?? "no reason recorded"}`);
      console.log(`${result.tokensBefore} tokens before, ${result.tokensAfter} after`);
      return;
    }

    session.messages = result.messages;
    saveSession(session);
    console.log(
      `compacted ${id}: ${estimateChatTokens(result.messages)} tokens ` +
        `(${result.tokensBefore} → ${result.tokensAfter}, ${result.calls} summarising call${result.calls === 1 ? "" : "s"})`,
    );
  });

// --- memory ----------------------------------------------------------------
const memory = program
  .command("memory")
  .description("inspect and edit this project's durable auto-memory (JAA-MEMORY.md)");

memory
  .command("list")
  .description("print this project's auto-memory")
  .option("--path", "print the file path only")
  .option("--rejected", "include notes withheld from context by the injection scan")
  .action((opts: { path?: boolean; rejected?: boolean }) => {
    const file = readMemory(process.cwd());
    if (opts.path === true) {
      console.log(file.path);
      return;
    }
    if (file.entries.length === 0) {
      console.log(`no auto-memory for this project (${file.path})`);
    } else {
      console.log(`auto-memory — ${file.path}\n`);
      for (const entry of file.entries) {
        console.log(`  ${entry.at === "" ? "(no date)" : entry.at}  ${entry.text}`);
      }
    }
    if (file.prose !== "") {
      console.log(`\n--- hand-written prose (left alone) ---\n${file.prose}`);
    }
    if (file.rejected.length > 0) {
      if (opts.rejected === true) {
        console.log(`\n--- withheld from context (${file.rejected.length}) ---`);
        for (const note of file.rejected) console.log(`  ${note}`);
      } else {
        console.log(
          `\n${file.rejected.length} note(s) are withheld from context because they read like instructions ` +
            `rather than facts. Show them with \`jaa memory list --rejected\`.`,
        );
      }
    }
  });

memory
  .command("add")
  .description("add notes to this project's auto-memory")
  .argument("<notes...>", "one or more facts to remember")
  .action((notes: string[]) => {
    const result = remember(notes, process.cwd());
    if (!result.written) {
      console.error(`jaa: could not write ${result.path} — the checkout may be read-only`);
      process.exitCode = 1;
      return;
    }
    console.log(`remembered ${notes.length} note(s) in ${result.path} (${result.kept} kept)`);
    if (result.dropped > 0) console.log(`${result.dropped} older note(s) were dropped to stay under the cap`);
  });

memory
  .command("edit")
  .description("print the file to edit, or open it in $EDITOR")
  .option("--print", "print the file instead of opening an editor")
  .action(async (opts: { print?: boolean }) => {
    const file = readMemory(process.cwd());
    if (opts.print === true || !process.env.EDITOR) {
      // Printing is the primary path: it works on a machine with no editor
      // configured, in CI, and over a pipe, which is where this is most often
      // needed. jaa never edits the file itself — the whole point of auto-memory
      // being visible is that a person owns it.
      console.log(`# ${file.path} — edit freely, jaa appends and trims.\n`);
      console.log(readFileSafe(file.path));
      return;
    }
    const { spawn } = await import("node:child_process");
    const child = spawn(process.env.EDITOR, [file.path], { stdio: "inherit", shell: true });
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

memory
  .command("clear")
  .description("remove every note from this project's auto-memory, keeping hand-written prose")
  .option("--yes", "skip the confirmation")
  .action((opts: { yes?: boolean }) => {
    const file = readMemory(process.cwd());
    if (file.entries.length === 0) {
      console.log(`no auto-memory to clear (${file.path})`);
      return;
    }
    if (opts.yes !== true) {
      console.error(`jaa: refusing without --yes; this removes ${file.entries.length} note(s) from ${file.path}`);
      process.exitCode = 1;
      return;
    }
    console.log(clearMemory(process.cwd()) ? `cleared auto-memory in ${file.path}` : `could not clear ${file.path}`);
  });

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "(no memory file yet — jaa creates it when the agent first calls `remember`)";
  }
}

// --- tasks ----------------------------------------------------------------
const tasks = program
  .command("tasks")
  .description("inspect and control the multi-agent task board (~/.jaa/tasks/)");

tasks
  .command("list")
  .description("list tasks on the board")
  .option("--running", "only tasks that have not finished")
  .option("--json", "emit the raw task records")
  .action(async (opts: { running?: boolean; json?: boolean }) => {
    const { listTasks } = await import("../orchestrator/task.js");
    const { unfinishedTasks } = await import("../orchestrator/background.js");
    const all = opts.running === true ? unfinishedTasks() : listTasks();
    if (opts.json === true) {
      console.log(JSON.stringify(all, null, 2));
      return;
    }
    if (all.length === 0) {
      console.log(opts.running === true ? "no running tasks" : "no tasks on the board");
      return;
    }
    for (const task of all) {
      const label = task.prompt.split("\n")[0]?.trim() ?? "";
      const bounded = label.length > 48 ? `${label.slice(0, 47)}…` : label;
      const usage = task.usage === undefined ? "" : ` · ${task.usage.inputTokens} in / ${task.usage.outputTokens} out`;
      const depth = task.depth > 0 ? ` · depth ${task.depth}` : "";
      const iso = task.isolation === "worktree" ? " · worktree" : "";
      console.log(`${task.id}  ${task.status.padEnd(9)} ${bounded || "(no prompt)"}${depth}${iso}${usage}`);
    }
  });

tasks
  .command("show")
  .description("show one task in full, including its scanned result")
  .argument("<id>", "task id")
  .action(async (id: string) => {
    const { loadTask, descendantsOf } = await import("../orchestrator/task.js");
    const task = loadTask(id);
    if (task === undefined) throw new Error(`task "${id}" is not on the board`);
    console.log(`id:       ${task.id}`);
    console.log(`status:   ${task.status}`);
    console.log(`depth:    ${task.depth}`);
    console.log(`agent:    ${task.agent ?? "(none)"}`);
    console.log(`isolate:  ${task.isolation}${task.workdir !== undefined ? ` at ${task.workdir}` : ""}`);
    console.log(`parent:   ${task.parent ?? "(root)"}`);
    console.log(`children: ${task.children.length === 0 ? "(none)" : task.children.join(", ")}`);
    if (task.usage !== undefined) console.log(`usage:    ${task.usage.inputTokens} in / ${task.usage.outputTokens} out`);
    if (task.error !== undefined) console.log(`error:    ${task.error}`);
    if (task.result !== undefined) {
      console.log(`\n--- result (already scanned) ---\n${task.result}`);
    }
    const children = descendantsOf(task.id);
    if (children.length > 0) {
      console.log(`\n--- descendants (${children.length}) ---`);
      for (const child of children) console.log(`${child.id}  ${child.status}`);
    }
  });

tasks
  .command("attach")
  .description("print the results of background tasks and summarise them")
  .argument("<ids...>", "task ids")
  .option("--json", "emit the raw collected records")
  .action(async (ids: string[], opts: { json?: boolean }) => {
    const { collectResults, summarize } = await import("../orchestrator/background.js");
    const results = collectResults(ids);
    if (opts.json === true) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    const summary = summarize(results);
    for (const line of summary.lines) console.log(line);
    console.log(
      `\n${summary.completed} completed · ${summary.failed} failed · ` +
        `${summary.cancelled} cancelled · ${summary.running} running` +
        (summary.stale > 0 ? ` · ${summary.stale} stale` : ""),
    );
    console.log(`${summary.usage.inputTokens} in / ${summary.usage.outputTokens} out`);
    // A missing task is a real failure the operator asked about, so it is
    // reflected in the exit code rather than only in the text.
    if (summary.failed > 0) process.exitCode = 1;
  });

tasks
  .command("stop")
  .description("ask one or more running tasks to stop (cooperative, checked between steps)")
  .argument("<ids...>", "task ids")
  .action(async (ids: string[]) => {
    const { requestStop } = await import("../orchestrator/background.js");
    let stopped = 0;
    for (const id of ids) {
      if (requestStop(id)) {
        console.log(`${id}: stop requested`);
        stopped++;
      } else {
        console.log(`${id}: not stopped (unknown, already finished, or the board could not be read)`);
      }
    }
    if (stopped === 0) process.exitCode = 1;
  });

tasks
  .command("clear")
  .description("remove finished tasks from the board")
  .option("--yes", "skip the confirmation")
  .action(async (opts: { yes?: boolean }) => {
    const { listTasks, removeTask } = await import("../orchestrator/task.js");
    const finished = listTasks().filter(
      (task) => task.status === "completed" || task.status === "failed" || task.status === "cancelled",
    );
    if (finished.length === 0) {
      console.log("no finished tasks to clear");
      return;
    }
    if (opts.yes !== true) {
      await confirmDestructive(
        `remove ${finished.length} finished task record(s) from the board? Their results and reports are deleted with them.`,
      );
    }
    let removed = 0;
    for (const task of finished) {
      if (removeTask(task.id)) removed++;
    }
    console.log(`removed ${removed} task record(s)`);
  });

/**
 * Everything bare `jaa` needs, and nothing more.
 *
 * The default is a plain session: no resume (there is no argument to name one),
 * no explicit provider, and tools and skills on, because that is what `jaa chat`
 * does with its own defaults. Reusing the same action rather than a second
 * implementation is the point — a chat that behaves differently depending on how
 * it was started would be two products, and the one you get by accident is the
 * one that gets trusted.
 */
async function launchDefaultChat(): Promise<void> {
  await program.parseAsync(["node", "jaa", "chat"]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Read the raw argv, not `program.args`. `program.args` holds the declared
  // *arguments* of the program, which is empty for a command with subcommands —
  // so it is empty for `jaa hooks list` just as it is for bare `jaa`, and
  // consulting it before parsing would send every subcommand to the help text.
  if (argv.length === 0) {
    if (shouldLaunchTui()) {
      await launchDefaultChat();
      return;
    }
    program.help();
    return;
  }
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(`jaa: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
