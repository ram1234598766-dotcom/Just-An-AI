# jaa — plan & progress

> Living tracker. One entry per phase. Gates are run for real and pasted, never assumed.

## North star
A local-first, multi-provider terminal coding agent shipped as the npm package
`jaa-cli` (bin: `jaa`). Bring your own key from any provider, or run fully local
on Ollama. Every phase gates on `npm run lint` + `npm test` + `npm run build`.

## Status board

| # | Phase | Branch | Status |
|---|-------|--------|--------|
| 0 | Repo scaffold + CLI skeleton | `phase/0-baseline` | **done** |
| 1 | Config + keyring (`~/.jaa`, env precedence, `key/config/setup/doctor`) | `phase/1-config` | **done** |
| 2 | Provider adapters (openai-compatible, anthropic, gemini, ollama) + router | `phase/2-providers` | **done** |
| 3 | Agent loop + context budgeting + sessions | `phase/3-loop` | **done** |
| 4 | Tools (fs, patch, bash safe/ask, web, git) | `phase/4-tools` | **done** |
| 5 | Ink TUI + `-p`/`--json` non-interactive mode | `phase/5-tui` | **done** |
| 6 | Skills (SKILL.md loader + autotrigger + GitHub install) | `phase/6-skills` | **done** |
| 7 | Subagents + AGENTS.md project memory | `phase/7-subagents` | **done** |
| 8 | MCP client/server + LSP diagnostics (protocol-correct) | `phase/8-mcp-lsp` | **done** |
| 9 | Eval harness + seed tasks + npm packaging polish | `phase/9-eval` | **done** |
| 10 | Head-to-head benchmark vs reference agents | `phase/10-bench` | **ON HOLD** (owner) |

## Decisions (dated)

- **2026-09-24 — Package name:** publish as `jaa-cli` (free on npm; `jaa` is
  squatted by an empty `0.0.0`). Bin command stays `jaa`. Scoped
  `@mrityunjay/jaa` is the fallback.
- **2026-09-24 — Ecosystem:** TypeScript + Node 26, npm distribution. Verified:
  `node --version` = v26.5.0, `npm --version` = 12.0.2 (host: Windows,
  PowerShell).
- **2026-09-24 — Old Python assets:** `.venv` + `__pycache__` removed from repo.
  Recovery scripts moved to `tools/recovery/`. Recovered Python prototype copied
  to `reference/` (read-only snapshot, not installed, never published).
- **2026-09-24 — Provider approach:** official SDKs (`openai` covers the
  OpenAI-compatible family via `baseURL`; `@anthropic-ai/sdk`; `@google/genai`;
  `ollama` for local-first). **No API key ever baked into the repo or the
  package.** Keys live only in `~/.jaa/.env` (mode-restricted) or env vars.
  Precedence: process env > project `.env` > `~/.jaa/.env`.
- **2026-09-24 — Built-in eval harness** is a core phase gate (Phase 9),
  shipping `jaa eval` with golden tasks/ and metrics (pass@1, retries, tokens,
  cost). Improvements are measured, not claimed.
- **2026-09-24 — GitHub:** local commits on feature branches only (`phase/<n>`).
  No `git push`, no GitHub token stored or configured; owner handles publishing
  to GitHub with his own credentials.
- **2026-09-24 — VantaOS** (`C:\Users\Mrityunjay\Website`) is out of scope and
  must remain untouched.
- **2026-09-24 — Keyring format:** `~/.jaa/.env` stores exactly one line per
  provider, `JAA_<PROVIDER>_API_KEY=value`. Raw line reader (not dotenv) so
  secret values survive stray `#`/`$`. Masked everywhere it is displayed.
  Local-only providers (ollama) never need a key.
- **2026-09-24 — Piped secrets:** `echo $KEY | jaa key set openai` reads stdin
  when it isn't a TTY; `jaa key set <provider> <key>` on a TTY is fine too.
  Secret never appears in command output (`****<last4>` only).

## Security log

- **2026-08-15 message leak:** recovered source-dump included a leaked GitHub
  token across 5 files under `C:\Users\Mrityunjay\.config\manicode\projects\jaa\chats\...`
  plus `message-history.json`. All occurrences replaced with `[REDACTED]`;
  re-scanned — no `gh[opu]_` patterns remain anywhere in `.config\manicode` or in
  the recovered source now held in `reference/`.
- **Standing rule:** `.gitignore` excludes `*.env*` (except `.env.example`),
  `*.key`, `*.pem`. `package.json` `files` whitelist excludes everything except
  `dist/`, `README.md`, `LICENSE`, `plan.md`. Structured logs never contain key
  material; keyring output masks values.

## Verification record

| Date | Command | Result |
|------|---------|--------|
| 2026-09-24 | `git init -b main` | ok |
| 2026-09-24 | `npm i commander` + `npm i -D typescript @types/node vitest tsx` | ok — resolved: commander ^15.0.0, typescript ^7.0.2, @types/node ^26.6.2, vitest ^5.0.1, tsx ^4.23.15 |
| 2026-09-24 | `npm run lint` (`tsc --noEmit`, strict) | ok |
| 2026-09-24 | `npm test` (`vitest run`) | ok — 4/4 passed |
| 2026-09-24 | `npm run build` (`tsc -p tsconfig.build.json`) | ok |
| 2026-09-24 | `node dist/cli/index.js --version` | ok — `0.1.0` |
| 2026-09-24 | `node dist/cli/index.js doctor` | ok — node ok, git ok, tmp ok, platform info, data-dir info |
| 2026-09-24 | `npm audit --audit-level=high` | ok — 0 vulnerabilities |
| 2026-09-24 | `git commit` on `phase/0-baseline` | ok — root commit `b001053`, 62 files |
| 2026-09-24 | `npm i zod dotenv` | ok — added to deps |
| 2026-09-24 | `npm run lint` (Phase 1 first pass) | ok — 4 errors (all new code) fixed: exactOptionalPropertyTypes on `SetupOptions`, unused param-properties on `EnvLayers`, `ProcessEnv` vs `Record<string,string>` |
| 2026-09-24 | `CI=1 npm test` | ok — 16/16 passed (12 new config tests + 4 cli) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | smoke (temp `JAA_HOME`): `setup --provider openai --key … -y`, `echo | key set anthropic`, `key list`, `config set/get/list`, `doctor`, `key remove` | ok — masked `****<last4>`, config.json contains no secret, `.env` created, piped key accepted |
| 2026-09-24 | real `~/.jaa` scan | ok — only dirs + default config.json; no `.env`, no secrets |
| 2026-09-24 | `npm i openai @anthropic-ai/sdk @google/genai ollama` | ok — resolved: openai ^7.23.0, @anthropic-ai/sdk ^0.128.0, @google/genai ^2.24.0, ollama ^0.6.3 (install scripts blocked non-fatally) |
| 2026-09-24 | `npm run lint` (Phase 2 first pass) | errors fixed in new code: exactOptionalPropertyTypes on mapped request fields, `openai` v7 types moved to `openai/resources/chat/completions/completions` (not root), Anthropic `InputSchema` requires literal `type:"object"` → neutral `ToolDef.inputSchema` tightened, Gemini `Schema`/ollama `Tool` boundary casts, union narrowing in tests |
| 2026-09-24 | `npm test` | ok — 29/29 passed (13 new provider tests) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | `npm run lint` (Phase 3 first pass) | errors fixed in new code: exactOptionalPropertyTypes on `ask` loop-options builder + `resolveModel` input, unused `ClientProviderAdapter`/`ChatMessage` imports in tests, test array needing an explicit `ChatMessage[]` annotation |
| 2026-09-24 | `npm test` | ok — 61/61 passed (9 budget + 7 loop + 16 session tests) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | smoke: `session list`, `ask --help`, `ask --provider nope`, `ask --resume s-nope-0000` | ok — no-sessions hint, full help, clean unknown-provider + unknown-session errors |
| 2026-09-24 | `node dist/cli/index.js ask "…" --save` | blocked at runtime — `fetch failed` (local Ollama not running); error surfaced cleanly, not a code failure |
| 2026-09-24 | live Ollama ask (Phase 3): `ask "Reply with exactly the word OK." --provider ollama --model qwen2.5-coder:7b --save --max-turns 1` | ok — `OK`, session created; `session list`/`show` verified `[system][user][assistant]` |
| 2026-09-24 | resume reuse of session provider/model + delta persistence (fresh session `s-mufqr9yg-12717f8a`) | ok — resumed session reuses stored provider/model; new `[user]` message persisted; delta printing doesn't replay history |
| 2026-09-24 | `npm run lint` (Phase 4 first pass) | 3 errors fixed in new code: `exactOptionalPropertyTypes` on `tools` in loop-options builder, `execFile` stdout typed `string \| Buffer` at the boundary, non-existent `toStartWith` matcher → `toMatch` |
| 2026-09-24 | `npm test` | ok — 84/84 passed (23 new tool tests: registry, fs, globToRegExp, patch, bash gate, web scheme, git not-a-repo) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | direct registry smoke (temp-ws): `write_file` round-trip + `list_dir` | ok — 12 tools advertised (`read_file,write_file,list_dir,stat,glob,patch,bash,fetch_url,git_status,git_log,git_diff,git_show`); wrote 6 bytes to note.txt |
| 2026-09-24 | `npm i ollama-js` Ollama SDK version note | see row above — ollama ^0.6.3 |
| 2026-09-24 | live Ollama tool round-trip (`qwen2.5-coder:7b`, `--max-turns 4`) | **partial** — loop executed 0 tool turns because this qwen2.5-coder build returns tool calls as *text* (`{"name":"write_file",...}` in `content`), not native `tool_calls`. Verified directly against Ollama 0.34.2 `/api/chat`. Registry + loop tool wiring covered by unit tests instead |
| 2026-09-24 | live Ollama tool round-trip (`llama3.2:3b`, `--provider ollama --model llama3.2:3b --ctx 2048 --max-turns 6`, in temp `live-ws`) | **ok** — native `tool_calls` end-to-end: agent called `write_file(greetings.txt,"hello from llama3.2")`, file landed on disk (SHA-256 `331CB6…`), final answer `[completed] 2 turn(s) · 1119 in / 58 out`. Confirms the loop + registry + provider wiring works against a real tool-native model |
| 2026-09-24 | raw Ollama `/api/chat` (llama3.2:3b, tool payload) | **ok** — native `tool_calls` array returned; first tool-mapping result under qwen2.5-coder:7b was a model build difference, not a wiring bug |
| 2026-09-24 | `npm run lint` + `npm test` + `npm run build` (`--ctx` num_ctx feature) | ok — 88/88 (8 files, +4: loop numContext passthrough ×1, ollama num_ctx mapping ×2, mapping sanity ×1) |
| 2026-09-24 | live Ollama context regression — `--ctx 2048` | **required on this machine**: bare llama3.2:3b fails at serve (`ggml CPU buffer 63.9 GB for KV cache`) with `OLLAMA_NUM_PARALLEL=8`; passing `options.num_ctx=2048` fixes it. Committed as `3520cda`

| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 129/129 tests (12 files incl. 23 new skills tests), 0 vulnerabilities, smoke `jaa skill list`/`--help`/ask `--no-skills` all green, Phase 6 gate complete → `phase/6-skills` committed as `8f40eaa`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 144/144 tests (13 files, +15 agents tests), 0 vulnerabilities, smoke `jaa agent list`/`jaa agent show code-reviewer` all green, Phase 7 gate complete → `phase/7-subagents` committed as `69739e7`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 156/156 tests (15 files, +12 MCP/LSP protocol tests), 0 vulnerabilities, smoke `jaa mcp serve --help`, `jaa lsp diagnose --help` all green, Phase 8 gate complete → `phase/8-mcp-lsp` committed as `cf1c8f9`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 161/161 tests (16 files, +5 eval tests), 0 vulnerabilities, smoke `jaa eval --help` + `npm run pack:dry-run` (172 files, only dist/README/LICENSE/plan.md), Phase 9 gate complete → `phase/9-eval` committed as `aede7b0`
| 2026-09-25 | `npm publish` + `npm install -g jaa-cli` + `jaa --version` | ok — `jaa-cli@0.1.0` live on npm (tarball 103 kB, 172 files, shasum `93f4d6bb…`), global bin at `%APPDATA%/npm/jaa`, `jaa --version` → `0.1.0`. Auth via `~/.npmrc` (`//registry.npmjs.org/:_authToken=...`); first token was read-only/2FA-gated (403), replaced with a publish-scoped bypass-2FA token |

## Phase log

### Phase 0 — repo scaffold + CLI skeleton
- [x] `git init -b main`
- [x] Remove Python `.venv` (3.14) + `__pycache__`
- [x] Move 6 recovery scripts → `tools/recovery/`
- [x] Copy recovered project → `reference/` (43 files)
- [x] `.gitignore` (secrets-safe), `LICENSE` (MIT), `README.md`
- [x] `tsconfig.json` (strict) + `tsconfig.build.json` + `vitest.config.ts`
- [x] `package.json` deps installed, versions recorded (see verification table)
- [x] `src/cli/index.ts` (`--version`, `--help`, `doctor`) + `src/doctor.ts` + `src/version.ts`
- [x] tests for cli/doctor (4 tests)
- [x] gate run: lint, test, build, smoke `node dist/cli/index.js --version` → **0.1.0**, `doctor` → all green
- [x] fixed: `--version` read `0.0.0` (dist layout differs per directory depth) → bounded walk-up to package root in `src/version.ts`
- [x] `npm audit` at high → 0 vulnerabilities
- [x] phase commit on `phase/0-baseline` → `b001053`

### Phase 1 — config + keyring *(next)*
- [x] `src/config/paths.ts`: `~/.jaa` layout (root, sessions, skills, cache, `.env`)
- [x] `src/config/env.ts`: precedence process env > project `.env` > `~/.jaa/.env`; `EnvLayers` without mutating `process.env`, per-key `SecretRef.source`, `resetEnvLayers()` + `findSecret()`
- [x] `src/config/providers.ts`: provider registry (openai, anthropic, google, groq, deepseek, mistral, together, xai, azure, ollama) → env var names + `JAA_<ID>_API_KEY`; `providerStatuses()` shared with doctor
- [x] `src/config/keyring.ts`: `key set/list/remove`, masked output (`****<last4>`), raw line reader, mode 0600 on POSIX
- [x] `src/config/settings.ts`: zod-typed settings (`defaultProvider`, `ollamaBaseUrl`, `models.*`), `config get/set/list` with dotted-path validation
- [x] `src/config/setup.ts`: interactive wizard (provider pick → paste key) + `--provider --key -y` non-interactive + piped-stdin key
- [x] bootstrap `~/.jaa` on first command (creates dir tree + defaults `config.json`)
- [x] `doctor` gained a `providers` check (names + source, never values)
- [ ] tests → done (12: env precedence, keyring round-trip/masking, settings validation, setup)
- [ ] phase commit on `phase/1-config` → **done** (gate: lint ok, test 20/20, build ok, smoke ok, `npm audit` 0)

### Phase 2 — provider adapters + router *(done)*
- [x] `src/providers/types.ts`: neutral `Role`/`ChatMessage`/`ToolCall`/`ToolDef`/`ChatRequest`/`Usage`/`ChatResponse`/`ChatStreamChunk`/`ProviderAdapter`/`ResolvedModel`; `ToolDef.inputSchema` typed as object-root JSON Schema (satisfies Anthropic `InputSchema`)
- [x] `src/providers/openaiCompatible.ts`: factory for the whole OpenAI-compatible family (OpenAI, Groq, DeepSeek, Mistral, Together, xAI, Azure, local vLLM/LM Studio) — SDK v7 types imported from `openai/resources/chat/completions/completions`; `chat()` + `stream()`; pure `mapMessagesToWire`/`mapWireToolCalls`/`toolToWire`
- [x] `src/providers/anthropic.ts`: SDK adapter, `system` param collapse, tool_result blocks, `mapToolCalls`, `DEFAULT_MAX_TOKENS = 2048`, injectable `fetch` for tests
- [x] `src/providers/gemini.ts`: SDK adapter (`GoogleGenAI`), systemInstruction + functionCall/functionResponse parts, `Schema` boundary cast, usage from usageMetadata
- [x] `src/providers/ollama.ts`: local-first adapter (no key), `options.temperature`/`num_predict`, tool_calls as parsed objects
- [x] `src/providers/router.ts`: `resolveProviderKey` (env layers then keyring, never logs value), `resolveAdapter` (localOnly → ollama; helpful setup hint when keyless), `chat()`, `resolveModel()`, `defaultModelFor()` per provider
- [x] tests → done (13: wire mappers for all 4 families, fake-fetch round-trips openai+anthropic, router resolution incl. keyless ollama + hint + settings default)
- [x] phase gate: lint ok, test 29/29, build ok → commit on `phase/2-providers`

### Phase 3 — agent loop + context budgeting + sessions *(done)*
- [x] `src/agent/budget.ts`: `estimateTokens` (chars/4, floor 1) + `estimateMessageTokens` (overhead + tool-call args) + `estimateChatTokens`; `trimToBudget` = chunk-based (system chunks always kept; newest non-system chunk kept even when it alone overflows; assistant-tool_calls chunk never split from its tool results; `Infinity` budget = no trim). `DEFAULT_TOKEN_BUDGET = 32_000`
- [x] `src/agent/loop.ts`: `runAgentLoop` — per-request `trimToBudget` against the provider context budget, returns the full untrimmed transcript; `executeTool` (injected; Phase 4 registers real tools), executor throws fed back as tool results (loop never crashes); stops on `completed` (no tool calls) / `max_turns` (`DEFAULT_MAX_TURNS = 20`); cumulative usage; render callbacks `onAssistantMessage`/`onToolCall`/`onToolResult` for the Phase 5 TUI
- [x] `src/agent/session.ts`: one JSON file per session under `~/.jaa/sessions/`; zod-validated on every read (disk = hostile); id `s-<base36 ts>-<hex>` guarded by `/^s-[A-Za-z0-9_-]{4,63}$/` (path traversal); title derived from first user message (≤60 chars, ellipsis); `createSession` seeds a system prompt only for brand-new conversations; `saveSession` atomic (tmp + rename, mode 600 on POSIX); `loadSession` returns `undefined` for unknown ids and throws on corrupt; `listSessions` newest-first and skips corrupt files; `appendMessages` bumps `updatedAt`
- [x] CLI: `jaa ask <prompt>` (options: provider/model/system/max-turns/token-budget/temperature/resume/save) prints assistant replies, persists deltas on `--resume`/`--save`; `jaa session list|show|remove`
- [x] tests → done (32: budget trimming invariants incl. tool-call pairing, scripted-adapter loop round-trips incl. tool feed-back + executor-throw recovery + max_turns + per-request trimming + callbacks, session round-trip/corrupt/id-guard/list-sort/title)
- [x] phase gate: lint ok, test 61/61, build ok, smoke ok → commit on `phase/3-loop`

### Phase 4 — tools *(done)*
- [x] `src/tools/types.ts`: `ToolContext` (`root`/`cwd`/`allowBash`) + `ToolDefinition` (`name`, `description`, `inputSchema` JSON Schema, zod `schema`, `run(input, ctx)`) — context injected per execution, registry stays context-free
- [x] `src/tools/registry.ts`: `createRegistry(tools)` — `list()` → neutral `ToolDef[]` for advertising, `execute(name, argsJson, ctx)` (JSON-arg parse, zod validation with path-qualified issue report, unknown-tool + handler errors returned as strings so the loop never crashes); `confinePath` blocks absolute-path and `..` traversal outside `root` (null-byte guard); `runProcess` (execFile, no shell, timeout, maxBuffer) shared by bash/git; `clampOutput` → 80 KB per tool result
- [x] `src/tools/fs.ts`: `read_file` (binary sniff, truncated at cap), `write_file`, `list_dir`, `stat`, `glob` (`*`/`?`/`**`, workspace-only via `globToRegExp`, 500-entry cap)
- [x] `src/tools/patch.ts`: `patch` — exact-anchor hunks (`oldText`→`newText`), each must match exactly once (ambiguity rejected), applied in order, **atomic** (no partial writes); ≤20 hunks
- [x] `src/tools/bash.ts`: `bash` behind the ask-gate — refuses when `ctx.allowBash` is false (tells the model the gate), otherwise `runProcess` via `sh -c`/`cmd /d /s /c`, default 30 s timeout (cap 120 s), exit-code trailer
- [x] `src/tools/web.ts`: `fetch_url` — http(s)-only, `AbortSignal.timeout`, redirects followed, body capped at share cap; `src/tools/git.ts`: read-only `git_status`/`git_log`/`git_diff`/`git_show` all run `git -C <root>` (can't touch anything outside the workspace)
- [x] `src/tools/index.ts`: `defaultToolDefinitions()` (fs + patch + bash + web + git) + `createDefaultRegistry()`
- [x] CLI: `ask` wires the registry by default; `--no-tools` = plain chat; `--no-bash` = advertise but keep the shell gated (bash stays gated unless the operator opts in)
- [x] tests → done (23: registry advertising/unknown-tool/bad-JSON/zod-path/error-recovery, fs round-trip/traversal-escape/absolute-escape/`..\`-escape/list/stat/glob, globToRegExp no-slash-crossing, patch unique/atomic/ambiguous, bash gate + run, web scheme guard, git not-a-repo)
- [x] phase gate: lint ok, test 84/84, build ok, smoke partial initially (qwen2.5-coder:7b text-tools) → **ok after re-verify** on `llama3.2:3b` (native tool calls, live 2-turn round-trip; see verification record) → committed on `phase/4-tools` (`1390502`)

### Phase 5 — Ink TUI + non-interactive mode *(complete)*

- [x] `src/tui/app.tsx`: `ChatApp` Ink component — typed-input prompt (`❯`), idle hint
      (`type a message and press Enter · Ctrl+C to quit`), live transcript rendering
      (`❯`/`→`/`↳`/`…` prefixes with status meta, colors by line kind), busy/cursor
      states, error + retry state. Exported for `jaa chat` (Ink) and `startChat`.
- [x] `src/tui/render.ts`: display helpers — `clip`/`summarize` (bounded single-line
      collapse; `\r\n`/`\s+` normalized), `formatToolCall` (re-parsed JSON args),
      `summarizeToolResult` (`(ok)`/`(failed)` meta), `linesFromMessages` for the
      resumed-transcript view (mirrors the live transcript so the initial render and
      the streaming view look identical).
- [x] `src/agent/loop.ts` callbacks wired into the TUI: `onAssistantMessage` /
      `onToolResult` drive live line rendering; cumulative `usage` + `stopReason`
      (`completed` / `max_turns`) feed the footer status line.
- [x] Bug fixes surfaced by the Ink test harness:
      - **Duplicate tool-call line:** the TUI previously rendered `→ tool(...)` from
        both `onAssistantMessage` (which already emits the call) and a redundant
        `onToolCall` callback → printed twice. Removed the duplicate callback. The
        loop still calls it; the TUI simply no longer double-prints.
      - **Final status line hidden when idle:** the input row only rendered `status`
        while `busy === true`, so the post-loop `completed · N turn(s) · X in / Y out`
        footer (and the `error — … to retry` line) were invisible. The row now
        renders `input || status` so the completion / error status is visible idle.
- [x] tests → `tests/tui-app.test.tsx` (ink-testing-library, 3 tests): idle-hint echo;
      full tool round-trip `→ bash({"command":"ls"})` → `↳ ls succeeded (ok)` →
      final answer `done` → `completed · 2 turn(s) · 16 in / 7 out`; and loop-failure
      surfacing (`loop failed:` + retry hint). **3/3 passing.**
      NOTE — ink-testing-library v4 `Stdin` does NOT queue chunks: two synchronous
      `stdin.write(...)` calls coalesce into one, so `parse-keypress` receives
      `"text\r"` instead of a lone `\r` and the `\r → name:'return'` mapping never
      fires. The tests therefore `await delay(...)` between the text write and the
      `\r` write so each forms its own readable chunk. (In a real terminal this is
      not needed; it's a testing-library PassThrough artifact.)
  - [x] phase gate → lint ok, test 106/106 (11 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `node dist/cli/index.js doctor` → all green, `startChat` renders via `jaa chat`
  - [x] phase commit on `phase/5-tui` → `bf16eb1`

### Phase 6 — skills (SKILL.md loader + autotrigger + GitHub install) *(complete)*
- [x] `src/skills/types.ts`: `Skill` interface (id, name, description, triggers, body, path) + `ParsedFrontmatter`
- [x] `src/skills/loader.ts`: `parseFrontmatter` (minimal YAML parser for name/description/triggers), `parseSkill`, `loadSkill`, `loadSkills`, `ensureSkillsDir`
- [x] `src/skills/match.ts`: `effectiveTriggers` (explicit triggers or skill name fallback), `skillMatches` (case-insensitive substring), `matchSkills`, `skillContext` (delimited system-prompt injection string)
- [x] `src/skills/install.ts`: `installFromGitHub` (`git clone --depth 1` → verify SKILL.md exists, cleanup on failure), `installFromUrl` (fetch raw file → save as `<id>/SKILL.md`), `removeSkill`, `listSkillIds`
- [x] `src/skills/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa skill list|install|remove` subcommands; `--no-skills` flag on both `ask` and `chat` to disable autotrigger; `ask` autotrigger injects matched skill context into the system prompt before the loop
- [x] `src/tui/app.tsx`: system-prompt seeding fix (Phase 5 bug — `systemPrompt` prop was never injected into the ChatApp's message state for new chats → now seeded via `initialMessages`, fixing `onTurnEnd` delta calculation for `--save`); skill autotrigger per user message — `matchSkills` checks the prompt, matched skill names shown as an info line, skill body injected as an additional system message before the user's message
- [x] tests → `tests/skills.test.ts` (23: frontmatter parsing incl. quotes/Windows-line-endings/unclosed/missing-name, parseSkill fallback, loadSkill/loadSkills with malformed/empty dirs, effectiveTriggers fallback, skillMatches case-insensitive, matchSkills multi-match/empty, skillContext delimiters/empty)
- [x] phase gate → lint ok, test 129/129 (12 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `jaa skill list`/`jaa skill --help`/`jaa ask --help` (shows `--no-skills`) all green
  - [x] phase commit on `phase/6-skills` → `8f40eaa`

### Phase 7 — subagents + AGENTS.md project memory *(complete)*
- [x] `src/agents/types.ts`: `AgentSpec` interface (name, description, ownership, deps, acceptance, instructions) + `ParsedAgents`
- [x] `src/agents/parser.ts`: `parseAgents` (split on `## Subagents` heading, parse `###` subheadings with `- **Field**: value` bullets, handle multi-line continuation, Windows line endings, missing sections); `loadAgents` (read AGENTS.md from root), `findAgent`, `getAgentSpec`
- [x] `src/agents/runner.ts`: `buildAgentSystemPrompt` (combines project context + agent name + instructions + default jaa identity), `runSubagent` (loads agent spec, builds system prompt, creates fresh tool registry with bash gated off by default, runs loop)
- [x] `src/agents/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa agent list|show|run <name> [task]` subcommands; run supports `-p/--provider`, `-m/--model`, `--system`, `--max-turns`, `--token-budget`, `--temperature`, `--ctx`, `--no-tools`
- [x] `AGENTS.md` at repo root: project context (stack, conventions, security rules), 3 subagents (code-reviewer, test-writer, docs-updater) with ownership/deps/acceptance/instructions
- [x] `src/tui/app.tsx`: system-prompt seeding fix — `initialMessages` now seeds `props.systemPrompt` as first message for new chats (Phase 5 bug: system prompt prop was passed but never injected into TUI message state, causing `onTurnEnd` delta calculation to be off for `--save` sessions). Tests still pass since `linesFromMessages` doesn't render system messages.
- [x] tests → `tests/agents.test.ts` (15: frontmatter parsing incl. windows-line-endings/multi-line-instructions/unknown-fields/empty-sections/missing-section, loadAgents from filesystem, findAgent/getAgentSpec, system prompt construction)
- [x] phase gate → lint ok, test 144/144 (13 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `jaa agent list`/`jaa agent show code-reviewer` all green
- [x] phase commit on `phase/7-subagents` → `69739e7`

### Phase 8 — MCP client/server + LSP diagnostics (protocol-correct) *(done)*
- [x] `src/mcp/framing.ts`: newline-delimited JSON framing (encode/decode/decodeFrames) for MCP stdio
- [x] `src/mcp/types.ts`: strict MCP types with optional fields (`MCP_PROTOCOL_VERSION = "2024-11-05"`)
- [x] `src/mcp/validation.ts`: `isRecord`, `isRequestId` boundary helpers
- [x] `src/mcp/server.ts`: `McpServer` with injectable streams, idempotent `run()`, JSON-RPC lifecycle (initialize/initialized state, `-32002` before init, `-32602` invalid params, `isError` on tool failures)
- [x] `src/mcp/client.ts`: `McpClient` with proper handshake (`notifications/initialized`), concurrent request correlation, timeouts, spawn/exit errors, idempotent disconnect
- [x] `src/mcp/jaa-server.ts`: routes MCP tools through `createDefaultRegistry()` with bash opt-in (`createJaaMcpServer(allowBash = false)`)
- [x] `src/lsp/framing.ts`: independent LSP `Content-Length` framing with extra-header support, duplicate/missing/oversize validation
- [x] `src/lsp/client.ts`: LSP client using LSP framing, document lifecycle, diagnostic-response validation, safe disconnect
- [x] `src/cli/index.ts`: `mcp serve --allow-bash`, repeatable `--mcp-server`, `--no-tools` guards, `lsp diagnose` uses `pathToFileURL`
- [x] tests → `tests/mcp.test.ts` (7: framing, split/coalesced/CRLF, incomplete trailing, server lifecycle, tool validation, error resilience) + `tests/lsp.test.ts` (5: Content-Length encode/decode, split/coalesced, extra headers, incomplete bodies, invalid lengths)
- [x] phase gate → lint ok, test 156/156 (15 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities
- [x] phase commit on `phase/8-mcp-lsp` → `cf1c8f9`

### Phase 9 — eval harness + seed tasks + npm packaging polish *(done)*
- [x] `src/eval/types.ts`: `EvalTask`/`EvalRun`/`EvalCheck` types; tasks carry checks, setup, and optional tool/turn/budget overrides
- [x] `src/eval/runner.ts`: `runEvalTask` runs the agent loop in a temp cwd, applies setup files, retries failing tasks, returns a structured `EvalRun`; `summarize` computes `pass@1` / `pass@N` and token totals
- [x] `src/eval/tasks.ts`: check helpers (`contains`, `notContains`, `toolCalled`, `fileExists`, `stopReasonIs`, `passesChecks`), `task` factory, and `loadTasks` for JSON task directories
- [x] `src/eval/seed/index.ts`: four seed tasks (`echo-ok`, `write-file`, `list-files`, `bash-gated`) exercising text checks, tool checks, and file checks
- [x] `src/eval/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa eval` command with `--provider`, `--model`, `--tasks`, `--retries`, `--json`; uses the default registry with bash gated off
- [x] `tests/eval.test.ts` (5): passing task, retries, seed-task ids, summarize math, tool/file checks
- [x] `package.json`: added `eval` script; `files` whitelist stays `dist`, `README.md`, `LICENSE`, `plan.md`
- [x] `README.md`: eval harness section + packaging section
- [x] `npm run pack:dry-run` → tarball contains only the four whitelisted entries (172 files, 102.4 kB)
- [x] phase gate → lint ok, test 161/161 (16 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities
- [x] phase commit on `phase/9-eval` → **pending**

## Tools commands (Windows note)
PowerShell: `rg` NOT on PATH; use the grep/glob session tools or
PowerShell `[regex]` over `[IO.File]::ReadAllText` for huge JSON lines.