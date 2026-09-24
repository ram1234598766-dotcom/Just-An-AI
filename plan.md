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
| 3 | Agent loop + context budgeting + sessions | `phase/3-loop` | pending |
| 4 | Tools (fs, patch, bash safe/ask, web, git) | `phase/4-tools` | pending |
| 5 | Ink TUI + `-p`/`--json` non-interactive mode | `phase/5-tui` | pending |
| 6 | Skills (SKILL.md loader + autotrigger + GitHub install) | `phase/6-skills` | pending |
| 7 | Subagents + AGENTS.md project memory | `phase/7-subagents` | pending |
| 8 | MCP client/server + LSP diagnostics (first cut) | `phase/8-mcp-lsp` | pending |
| 9 | Eval harness + seed tasks + npm packaging polish | `phase/9-eval` | pending |
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

> Final Phase 0 gate output gets pasted here before the phase commit.

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

## Tools commands (Windows note)
PowerShell: `rg` NOT on PATH; use the grep/glob session tools or
PowerShell `[regex]` over `[IO.File]::ReadAllText` for huge JSON lines.