# jaa - plan & progress

> Living tracker. One entry per phase. Gates are run for real and pasted, never assumed.

## North star

A local-first, multi-provider terminal coding agent shipped as the npm package
`jaa-cli` (bin: `jaa`). Bring your own key from any provider, or run fully local
on Ollama. Every phase gates on `npm run lint` + `npm test` + `npm run build`.

**The bar:** jaa must be strictly better than the *union* of Claude Code, OpenAI
Codex CLI, DeepSeek Harness (`dsh`), and opencode taken together -- not better
than any one of them. That means it must adopt every capability any of them
ships well, keep the two advantages it already has, and add the one thing none
of them have.

## The thesis

Three claims define the product. Everything in the roadmap serves one of them.

1. **Provider freedom is table stakes, not a feature.** Claude Code is
   Anthropic-only. Codex is OpenAI-only. opencode and jaa accept any provider.
   jaa keeps this and extends it (OAuth subscription auth, reasoning-effort
   control, OpenAI Responses API, prompt caching).
2. **Compatibility is the real moat.** Every team already has `CLAUDE.md`,
   `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.mcp.json`, and a `config.toml`
   with MCP servers in it. jaa reads all of them, writes all of them, and runs
   as an MCP server inside the others. Switching to jaa must cost zero
   reconfiguration. No competitor does this.
3. **Measured, not claimed.** Phase 10 is a benchmark harness, not a feature.
   "Better" is a number produced by running the same tasks through jaa and the
   reference harnesses. Phases 11-20 are gated on moving that number.

## Competitive position (as of 2026-09-25)

Legend: `yes` = ships today, `partial` = exists but materially behind,
`no` = absent. Sources: vendor docs for each project, cross-checked against a
third-party integration survey (Calyx, Sep 2026) that pins exact versions.

| Capability | Claude Code 2.1.x | Codex 0.151 | DeepSeek dsh | opencode 1.18 | jaa 0.1.0 |
|---|---|---|---|---|---|
| Providers | Anthropic only | OpenAI only | any (plugin) | 75+ | 10 -- **wins** |
| Local models (Ollama) | no | `--oss` only | any | yes | yes -- **wins** |
| Multi-provider routing | no | no | yes | yes | yes -- **wins** |
| MIT / open source | no (CLI only) | Apache-2.0 | MIT | MIT | MIT -- ties |
| Hooks (lifecycle events) | yes (10) | yes (9) | plugin events | yes (7) | **no** |
| OS-level sandbox | Seatbelt/bwrap | Landlock+seccomp | pluggable | Docker | **partial** (path check) |
| Permission model | allow/deny/ask/defer | 3 policies x 3 modes | guard + monotonic deny | rule-based | **partial** (1 boolean) |
| Multi-agent | subagents + teams + workflows | 6 threads, depth, CSV fan-out | subagents + workflows | sessions | **partial** (1 sync agent) |
| Worktree isolation | yes | yes | -- | -- | **no** |
| Checkpoint / rewind | yes (Esc Esc) | fork + worktree | -- | snapshots | **no** |
| Compaction | summarize ~95% | model-native | plugin | summarize ~90% | **partial** (truncate) |
| Live LSP in the loop | yes | via MCP | -- | 30+ auto | **partial** (manual) |
| Plugin packaging | marketplaces | 90+ plugins | everything-is-plugin | plugin array | **no** |
| Code Mode (TS orchestrator) | -- | -- | yes | -- | **no** |
| Cross-harness config read | CLAUDE.md | AGENTS.md | AGENTS.md | AGENTS.md | AGENTS.md only |
| Cross-harness config write | -- | -- | -- | -- | **no** |
| Headless JSON mode | `-p` | `exec --output json` | SDK / JSON-RPC | `run` | `ask --json` |
| Background / scheduled | durable cron, wakeup | persisted goals, queue | jobs | background bash | **no** |
| TUI depth | strong | strong (Rust) | web UI | strong (Go) | **partial** (basic Ink) |

### What jaa already wins, and must not lose

- **Provider freedom.** 10 providers behind one interface, including the entire
  OpenAI-compatible family via `baseURL`. Neither Claude Code nor Codex can do
  this. This is the exit ramp from any vendor's pricing.
- **Local-first with real tools.** Ollama works end-to-end with native tool
  calls, not just chat. Verified live against `llama3.2:3b`.
- **Auditable from source.** MIT, ~4.4k lines of strict TypeScript, 161 tests.
  Read the whole agent in an afternoon. Claude Code is closed.
- **Eval harness in the box.** `jaa eval` ships with pass@1 / pass@N and token
  accounting. Most competitors measure you externally; jaa measures itself.

### Where jaa is behind, ranked by how much it would cost to lose a user

1. **No real permission model.** One boolean (`allowBash`). Codex has 9
   combinations, Claude Code has 4 decisions plus rule files. A user who works
   on a production repo cannot use jaa safely today. This is the adoption
   blocker.
2. **No OS-level sandbox.** `confinePath` validates paths; it does not contain
   a process. Once `allowBash` is true, every command runs with full user
   privileges. Codex uses Landlock + seccomp; Claude Code uses Seatbelt. This is
   the trust blocker.
3. **No hooks.** All four competitors have them. It is how a team enforces
   policy, runs linters on edit, and blocks dangerous commands. Its absence
   makes jaa unusable in a team setting.
4. **Multi-agent is single-threaded.** `jaa agent run` is one synchronous agent
   with no parallelism, no worktree isolation, no background execution. This is
   the capability gap.
5. **No rewind.** No checkpoints means no safe experimentation. Every
   competitor has some form.
6. **TUI is shallow.** No multi-pane, no agent dashboard, no typed tool cards,
   no themes or keybinds. The most visible surface is the least developed.
7. **No plugin packaging.** Skills and subagents exist but cannot be bundled
   and distributed as one installable unit with hooks and MCP servers.
8. **LSP is manual.** `jaa lsp diagnose` is a one-shot command. Competitors
   feed diagnostics into the loop after every edit.

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
| 10 | Benchmark + parity harness (the measuring stick) | `phase/10-bench` | **next** |
| 11 | Permission system (allow/deny/ask/defer + rules) | `phase/11-permissions` | **done** |
| 12 | OS-level sandbox (Seatbelt / Landlock / Job Objects) | `phase/12-sandbox` | planned |
| 13 | Hooks (lifecycle events + blocking decisions) | `phase/13-hooks` | planned |
| 14 | Checkpoint, rewind and fork | `phase/14-checkpoint` | planned |
| 15 | Multi-agent orchestration (parallel + worktrees + background) | `phase/15-multiagent` | planned |
| 16 | Compaction and persistent memory | `phase/16-compaction` | planned |
| 17 | Live code intelligence (LSP in the loop) | `phase/17-lsp-loop` | planned |
| 18 | Compatibility and interop layer | `phase/18-compat` | planned |
| 19 | Plugin system and registry | `phase/19-plugins` | planned |
| 20 | TUI overhaul (multi-pane, tool cards, dashboard) | `phase/20-tui` | planned |

### Dependency order

```
10 benchmark
  |
  +-- 11 permissions  --> 12 sandbox  --> 13 hooks
                                  |
  +-- 14 checkpoint ---------------+--> 15 multi-agent
                                              |
  +-- 16 compaction                            |
  +-- 17 lsp-loop                             |
  +-- 18 compat                               |
  +-- 19 plugins ------------------------------+
  +-- 20 tui (renders everything above it) <----+
```

Rationale: permissions before sandbox (the sandbox is what permissions toggle),
permissions before hooks (a `PreToolUse` hook returns a permission decision),
checkpoint before multi-agent (worktree isolation and rewind share the same
snapshot machinery), and TUI last so it can render diagnostics, subagent
activity, and permission prompts that only exist by Phase 19.

## Decisions (dated)

- **2026-09-25 — Competitive bar set:** jaa must beat the *union* of Claude Code,
  Codex CLI, DeepSeek Harness, and opencode, not any one of them. Phases 11-20
  are the competitive core; anything outside it is listed under "Deferred past
  Phase 20" rather than silently dropped.
- **2026-09-25 — Benchmark before features:** Phase 10 lands before Phase 11 so
  every later phase can be gated on a movement in a measured number. The task
  set is committed before any result is recorded, to stop the benchmark being
  tuned to flatter jaa.
- **2026-09-25 — Dependency order is fixed:** permissions (11) before sandbox
  (12) before hooks (13); checkpoint (14) before multi-agent (15); TUI (20)
  last so it can render what the earlier phases produce. Reordering breaks
  stated preconditions.
- **2026-09-25 — Compatibility is the moat, not a feature:** jaa reads
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc`,
  `.windsurfrules`, `.github/copilot-instructions.md`, `.mcp.json`,
  `~/.codex/config.toml`, and `opencode.json`; and writes `AGENTS.md`,
  `CLAUDE.md`, and `.mcp.json`. Full matrix above.
- **2026-09-25 — Never execute foreign plugin code silently:** `.opencode/plugins/*.js`
  and plugin-provided hooks are *listed* in `jaa doctor`, never evaluated during
  detection. Installing executable content requires explicit confirmation, and
  plugin tools are subject to the same permission engine and sandbox as
  built-ins.
- **2026-09-25 — Never clobber another tool's config:** jaa writes only files it
  created, tracked in `.jaa/compat-manifest.json`. `AGENTS.md` and `CLAUDE.md`
  need `--force` to overwrite. Every other export is stdout only.
- **2026-09-25 — Platform honesty over platform claims:** if an OS sandbox
  primitive is unavailable, `jaa doctor` says so with the reason and the
  affected guarantee. Windows has no Seatbelt equivalent, so its containment is
  documented as Job Objects plus an ACL guard, not as equivalent isolation.
- **2026-09-25 — Conservative multi-agent defaults:** `max_depth` defaults to 1
  and `max_threads` to 6, matching Codex's guidance that deeper recursion turns
  broad delegation into repeated expensive fan-out. Fan-out is opt-in.
- **2026-09-25 — Package name:** publish as `jaa-cli` (free on npm; `jaa` is
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
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 161/161 tests (16 files, +5 eval tests), 0 vulnerabilities, smoke `jaa eval --help` + `npm run pack:dry-run` (172 files, only dist/README/LICENSE/plan.md), Phase 9 gate complete → `phase/9-eval` committed as `aede7b0` |
| 2026-09-25 | `npm run lint + CI=1 npm test + npm run build + npm audit --audit-level=high` | ok — 190/190 tests (17 files, +29 bench tests), 0 vulnerabilities. Phase 10 gate: `jaa bench --list` → 46 cases / 10 tags; live `jaa bench --tags debug --timeout 8000 --out <ndjson>` ran 7 cases end-to-end, all recorded as FAIL with `error: agent loop failed: fetch failed` (no local model reachable) and **no crash**; resume re-run added 0 duplicate rows. Baseline reads 0% only because no model was available on the host, not because of a code fault. Competitor parity numbers **not verified** — no competitor binary was invoked |
| 2026-09-25 | `npm run lint + CI=1 npm test + npm run build + npm audit --audit-level=high` | ok — 268/268 tests (18 files, +55 permission tests), 0 vulnerabilities. Phase 11 gate: `jaa perm list` / `jaa perm test` verified end to end. Two independent security reviews were run; the first returned **BLOCK** with 2 critical + 6 major findings, the second found 2 further criticals in the fixes. All were fixed and each is now a named regression test: shell-operator chaining cannot widen a prefix allow, whitespace/case cannot evade a prefix deny, `./`/`../`/absolute/case path variants all hit the same rule, `full-auto` never implies bash, an MCP-provided unknown tool never inherits a mode baseline, a malformed config warns instead of silently voiding denies, and a bad `allow` no longer discards a valid `deny`. `jaa chat` was found completely ungated and is now gated |
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

## Compatibility and interop matrix

The single differentiator. jaa must adopt a repository that is already
configured for other harnesses, and be adoptable by teams already using jaa.

### Read (import) -- jaa consumes these on startup

| Source | Format | Consumed as | Notes |
|---|---|---|---|
| `AGENTS.md` (repo root) | Markdown | project memory + subagents | Universal standard. Codex, opencode, DeepSeek all read it. Already supported. |
| `~/.codex/AGENTS.md` | Markdown | global project memory | Codex global layer. Precedence below repo `AGENTS.md`. |
| `CLAUDE.md` | Markdown | project memory | Claude Code. Merged below `AGENTS.md` when both exist. |
| `CLAUDE.local.md` | Markdown | local project memory | Gitignored Claude override layer. |
| `GEMINI.md` | Markdown | project memory | Gemini CLI. |
| `.cursorrules` | Plain text | project memory | Legacy Cursor. |
| `.cursor/rules/*.mdc` | Markdown + frontmatter | project memory (per-glob) | Modern Cursor rules. Each file scoped to its glob. |
| `.windsurfrules` | Markdown | project memory | Windsurf. |
| `.github/copilot-instructions.md` | Markdown | project memory | GitHub Copilot. |
| `.claude/skills/*/SKILL.md` | Frontmatter + Markdown | skills | Identical format to jaa skills. Zero conversion. |
| `.claude/agents/*.md` | Frontmatter + Markdown | subagents | `name`, `description`, `tools`, `model` mapped. |
| `.claude/commands/*.md` | Markdown | skills | Flat command files map to skills. |
| `.claude/settings.json` | JSON | permission rules + hook hints | `permissions.allow` / `.deny` translated. |
| `.mcp.json` | JSON | MCP servers | Claude Code project-scoped MCP. `mcpServers` map to jaa clients. |
| `~/.codex/config.toml` | TOML | MCP servers + model defaults | Parse `[mcp_servers.*]`, `model`, `sandbox_mode`. |
| `~/.config/opencode/opencode.json` | JSON | MCP servers + plugins + instructions | `mcp`, `plugin`, `instructions` mapped. |
| `opencode.json` (project) | JSON | same, project layer | Merged below the global layer. |
| `.opencode/plugins/*.js` | JavaScript | *not executed* | Listed in `jaa doctor` as detected-but-unsupported. Never eval foreign code. |
| `pyproject.toml` / `package.json` | TOML / JSON | project-type detection + test command | Feeds `jaa doctor` and the benchmark runner. |

Precedence, highest first: `jaa` native `AGENTS.md` section > `AGENTS.md` >
`CLAUDE.md` > `GEMINI.md` > `.cursor/rules/*.mdc` > `.cursorrules` >
`.windsurfrules` > `.github/copilot-instructions.md`. Every source is
attributed in `jaa doctor` so the user can see exactly what was loaded and from
where. No source is ever silently rewritten.

### Write (export) -- jaa emits these

| Target | Command | Contents |
|---|---|---|
| `AGENTS.md` | `jaa compat sync` | Generated project memory: stack detection, conventions, build/test/lint commands, subagent index. Written only when the file is absent or `--force` is passed. Never clobbers hand-written prose. |
| `CLAUDE.md` | `jaa compat sync` | Pointer file to `AGENTS.md` plus a Claude-specific header, so Claude Code picks up jaa's context without duplication. |
| `.mcp.json` | `jaa compat sync` | Registers `jaa mcp serve` as an MCP server, so Claude Code can call jaa's tools. |
| `opencode.json` snippet | `jaa compat print opencode` | Printed to stdout, never written silently. |
| `config.toml` snippet | `jaa compat print codex` | `[mcp_servers.jaa]` table for Codex. Printed, never written silently. |
| `.jaa/config.json` | native | Canonical jaa settings. Source of truth. |

Hard rule: **jaa never writes to a file it did not create, except `AGENTS.md`
and `CLAUDE.md` with an explicit `--force`.** Every other export is stdout.

### Export surfaces -- other tools consume jaa

| Surface | Command | Consumed by |
|---|---|---|
| MCP stdio server | `jaa mcp serve` | Claude Code, Codex, opencode, DeepSeek, any MCP client |
| Headless JSON | `jaa ask -p "<q>" --json` | Scripts, CI, editor integrations |
| Codex-compatible JSON | `jaa exec --output json` | Drop-in for `codex exec --output json` consumers |
| Stream JSON | `jaa exec --output stream-json` | Live UIs; one JSON object per event |
| Exit codes | `jaa exec` | CI: `0` pass, `1` agent error, `2` permission denied, `3` budget exceeded |
| Skill directory | `~/.jaa/skills/` | Symlinked or copied by other harnesses (SKILL.md is a shared standard) |
| Subagent definitions | `jaa agent export` | Emits `.claude/agents/*.md` and `.codex/agents/*.toml` |

### The acceptance test for Phase 18

A repository containing all of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.cursorrules`, `.cursor/rules/style.mdc`, `.mcp.json`, and a
`~/.codex/config.toml` with two MCP servers must, with zero jaa-specific
configuration:

1. `jaa doctor` report every detected source with its path and precedence rank.
2. `jaa ask` have all of the project memory in context.
3. `jaa ask` have both MCP servers' tools available.
4. `jaa compat sync` create `CLAUDE.md` and `.mcp.json` that make Claude Code
   able to call `jaa mcp serve`.
5. `jaa eval` run without configuration errors.

A test fixture repository encoding all of those files is a required Phase 18
deliverable, with a test per numbered assertion.

## Roadmap phase specs (10-20)

Each phase lists the gap it closes, concrete deliverables, the gate that must
pass, and what could regress. No phase is "done" until its gate output is
pasted into the verification record above.

---

### Phase 10 - Benchmark and parity harness

**Gap closed:** every other phase in this roadmap. Without it, "better than the
union of four harnesses" is an assertion. With it, it is a number.

**Why first:** it is the measuring stick for 11-20 and it reuses the Phase 9
eval harness rather than replacing it.

- [x] `src/bench/types.ts` - `BenchCase` (id, prompt, tags, checks, setup,
      budget, timeout), `BenchResult`, `HarnessAdapter`, 10 declared tags
- [x] `src/bench/checks.ts` - 20 check builders over transcript, work tree, and
      tool calls (`fileExists`, `fileContains`, `fileAbsent`,
      `fileLineCountAtLeast`, `finalContains`, `finalMatches`, `finalLacks`,
      `toolCalled`, `notToolCalled`, `toolCalledAtLeast`, `turnsAtMost`,
      `turnsAtLeast`, `touched`, `untouched`, `errored`, `noError`, `all`,
      `any`, `caseOf`)
- [x] `src/bench/cases.ts` - **46 cases** across all 10 tags, committed before
      any result is recorded. 22 of 46 (48%) are tool-agnostic, above the
      one-third floor, so the set cannot be tuned to flatter the tool layer
- [x] `src/bench/runner.ts` - throwaway case directory, setup application,
      before/after tree snapshot for `diffFiles`, hard per-case timeout that
      converts a hang into a recorded error rather than a crash, and `cwd`
      stripped from the result unless `keepWorkdir` is set
- [x] `src/bench/harnesses/jaa.ts` - in-process adapter driving the real agent
      loop with the default tool registry, bash gated off by default
- [x] `src/bench/harnesses/cli.ts` - generic external-CLI adapter with
      `{{prompt}}` / `{{cwd}}` / `{{model}}` templating, PATH availability
      probe, output-size caps, SIGTERM then SIGKILL escalation, tolerant JSON
      extraction, and a normalizer that maps each vendor's field names
      (`result` / `output` / `text` / `finalText`, `input_tokens` /
      `prompt_tokens`, ...). Presets for `claude`, `codex`, `opencode`, `dsh`
- [x] `src/bench/matrix.ts` - cross-product runner, incremental NDJSON append
      after every case, resume keyed on `caseId::harness::model`, tolerant of a
      truncated trailing line from an interrupted run
- [x] `src/bench/report.ts` - per-harness pass rate, median wall time, median
      turns, token and cost totals, per-tag breakdown, Markdown and JSON
- [x] `src/cli/index.ts` - `jaa bench --harness --provider --model --tags
      --timeout --out --report --list --json --allow-bash`
- [x] `tests/bench.test.ts` - 29 tests: every check builder, runner pass/fail/
      timeout/error/skip, diff capture, work-dir retention, matrix cross
      product, resume, NDJSON round-trip, truncated-line tolerance, report math,
      empty-report safety, case-set invariants (unique ids, all tags covered,
      tool-agnostic floor), external adapter availability, JSON parsing,
      malformed-output handling, and the real jaa adapter
- [ ] `docs/benchmarks/RESULTS.md` - the first published parity table.
      **Blocked on a reachable model.** No local Ollama instance was running and
      no provider key was supplied, so no honest pass rate exists yet. Run
      `jaa bench --harness jaa,codex,claude --out results.ndjson --report
      docs/benchmarks/RESULTS.md` on a machine with the binaries and a model
      before claiming any parity claim

**Gate result:** lint 0, 190/190 tests, build 0, audit 0. `jaa bench --list`
lists 46 cases across 10 tags. A live 7-case run completed with correct
per-case error capture and no crash, and resume added no duplicate rows.
**Parity numbers: not verified** — see the blocked item above.

---

### Phase 11 - Permission system

**Gap closed:** ranked #1 adoption blocker. One boolean becomes a real model.

**Competitor parity:** Codex 3 approval policies x 3 sandbox modes; Claude Code
allow/deny/ask/defer plus rule files; DeepSeek a monotonic deny guard layered
over allow/deny/ask.

- [x] `src/permissions/types.ts` - `Decision` (`allow`/`deny`/`ask`/`defer`),
      `Rule` (optional tool glob, command prefix, path glob, plus a `source` for
      attribution), `PermissionRequest`, `PermissionOutcome`, `GateOptions`
- [x] `src/permissions/rules.ts` - specificity ranking (exact tool > tool glob >
      command prefix > path glob > catch-all), glob compilation where `*` does
      not cross a separator and `**` does, case-insensitive tool matching,
      `normalizeRequestPath` so a rule sees the file the tool actually opens,
      `normalizeWhitespace` + shell-operator detection for command prefixes,
      `importClaudeSettings` mapping `Bash(cmd:*)` / `Read(glob)` / bare names
- [x] `src/permissions/engine.ts` - `createEngine` where **deny is absolute**,
      `resolveDecision` applying the mode baseline, and `createPermissionGate`
      wrapping a tool executor. Non-interactive `ask` becomes `deny`, never a hang
- [x] `src/permissions/ask.ts` - `SessionGrants` (exact match over *all*
      arguments), `sanitizeForDisplay` stripping ANSI/C0 so the consent prompt
      cannot be repainted by injected escapes, and `askOnTty` that keeps the
      readline interface open until the answer arrives
- [x] `src/config/settings.ts` - zod `permissions` block; a parse failure now
      warns and salvages each field independently so a bad `allow` cannot void a
      valid `deny`; zod default is a factory so the shared array cannot leak
- [x] installed on `jaa ask`, `jaa chat` (previously ungated entirely), and
      `jaa agent run`; subagents no longer inherit shell access just because
      tools are enabled
- [x] project `.claude/settings.json` detected and reported but **not applied**
      without `--trust-project-settings`, because it lives in an untrusted
      checkout
- [x] `src/doctor.ts` - `permissions` check reporting mode, rule counts, whether
      bash is reachable, and project-policy provenance
- [x] `src/cli/index.ts` - `jaa perm list|test`, `--permission-mode` on
      `ask`/`chat`/`agent run`, `--allow-bash` and `--no-tools` on `agent run`
- [x] `tests/permissions.test.ts` (55): specificity ordering, matching, engine
      precedence, absolute deny, mode baselines, Claude import, the gate, and one
      regression test per exploit found in review (shell chaining, whitespace
      and case evasion, `./`/`../`/absolute path bypass, `full-auto` bash,
      unknown-tool allow, dead config warning, per-field salvage, grant scope)

**Gate result:** lint 0, 268/268 tests (18 files, +55), build 0, audit 0.
`jaa perm list` and `jaa perm test` verified end to end, including the exact
exploits from two security review rounds, each now returning `ask` or `deny`
where they previously returned `allow`.

**Deliberately out of scope for Phase 11:** the MCP server, `jaa eval`, and the
bench harness still call their registries directly. All three have
`allowBash` off by default, so they cannot reach a shell, but a `deny` rule does
not currently apply to them. Gating them is Phase 13 work alongside hooks,
where a shared `ToolContext` carries the resolved policy.

---

### Phase 12 - OS-level sandbox

**Gap closed:** ranked #2 trust blocker. Path validation is not containment.

**Competitor parity:** Codex Landlock + seccomp on Linux, Seatbelt on macOS;
Claude Code Seatbelt and bubblewrap; opencode Docker. jaa targets all three
desktop platforms with no Docker requirement.

- [ ] `src/sandbox/types.ts` - `SandboxPolicy` (writable roots, readable roots,
      network, process spawn, env passthrough), platform capability probe
- [ ] `src/sandbox/darwin.ts` - generate and exec a Seatbelt profile via
      `sandbox-exec`; writable roots from the Phase 11 decision
- [ ] `src/sandbox/linux.ts` - Landlock LSM rules plus a seccomp-bpf filter;
      bubblewrap as the portable fallback when Landlock is unavailable
- [ ] `src/sandbox/win32.ts` - Job Objects for process containment plus an ACL
      guard on writable roots. Windows has no Seatbelt equivalent; be explicit
      in docs about what is enforced versus advisory
- [ ] `src/sandbox/detect.ts` - probe what the host actually supports, cache
      the result, and surface it in `jaa doctor`
- [ ] `src/sandbox/apply.ts` - wrap every `runProcess` call site; a tool that
      cannot be sandboxed must declare so rather than silently run wide
- [ ] `src/tools/bash.ts` and `src/tools/git.ts` route through the sandbox
- [ ] `src/doctor.ts` - `sandbox: <mechanism> (read-only/write/network)` or an
      explicit "unavailable on this host" with the reason
- [ ] `tests/sandbox/*.test.ts` - policy generation per platform, escape
      attempts against a temp tree, network-denial, plus a skip-with-reason on
      hosts without the primitive

**Gate:** on each supported platform, a command that writes outside the
declared roots fails, and a network call under `network: false` fails. Tests
skip with an explicit reason where the OS primitive is missing -- never a
silent pass. `jaa doctor` names the active mechanism.

**Risk:** platform sandboxing is the single most failure-prone area in this
roadmap. Mitigation: every platform module is independently testable, the
capability probe is mandatory before any enforcement is claimed, and an
unavailable primitive downgrades to an explicit warning rather than a lie.

---

### Phase 13 - Hooks

**Gap closed:** ranked #3 team-usability blocker. All four competitors have
hooks; jaa has none.

**Competitor parity:** Claude Code 10 events, Codex 9, Grok 12, opencode 7.
jaa targets the Claude Code event vocabulary for drop-in familiarity.

- [ ] `src/hooks/events.ts` - the event union: `SessionStart`,
      `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
      `PostToolBatch`, `PermissionRequest`, `Notification`, `SubagentStart`,
      `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`,
      `SessionEnd`, `ConfigChange`
- [ ] `src/hooks/types.ts` - `HookHandler` discriminated by kind, `HookEvent`
      payload mirroring the Claude Code JSON shape, `HookDecision`
- [ ] `src/hooks/load.ts` - read `hooks` from `jaa` config, `AGENTS.md`
      frontmatter, `.claude/settings.json`, and plugin manifests; later layers
      merge, never replace
- [ ] `src/hooks/run.ts` - dispatch to `command` (stdin JSON, parse stdout),
      `http` (POST the payload), `prompt` (inject into context),
      `mcp` (call a server tool), `agent` (spawn a subagent for a verdict)
- [ ] `src/hooks/decide.ts` - `PreToolUse` and `PermissionRequest` may return
      allow / deny / ask, may rewrite tool arguments via `updatedInput`, and
      `PostToolUse` may rewrite the result. A handler that crashes or times out
      must resolve to the safe default (deny for pre-use, passthrough for
      post-use), never to allow
- [ ] Timeout and output caps per handler; stdout clamped like any tool result
- [ ] `src/cli/index.ts` - `jaa hooks list|test <event>`; `test` runs a
      synthetic payload through the chain and prints the decision trace
- [ ] `tests/hooks.test.ts` - every event, every handler kind, deny/ask/allow
      decisions, argument rewrite, crash-to-deny, timeout-to-deny, layer merge

**Gate:** a `PreToolUse` hook can block a tool call. A `PostToolUse` hook can
rewrite a result. A crashing hook denies rather than allows. Imported Claude
Code `PreToolUse` deny rules fire.

**Risk:** arbitrary command execution from config is a security surface. Phase
11 gates it, Phase 12 contains it, and project-level hooks require the same
workspace-trust prompt Claude Code uses.

---

### Phase 14 - Checkpoint, rewind and fork

**Gap closed:** ranked #5. No safe experimentation without rewind.

**Competitor parity:** Claude Code snapshots before every edit, `Esc Esc` and
`/rewind` restore code and conversation; Codex forks threads and isolates in
worktrees; opencode uses git write-tree snapshots.

- [ ] `src/checkpoint/store.ts` - content-addressed snapshots of every file the
      agent writes, stored under `~/.jaa/checkpoints/<session>/`, deduplicated
      by hash so an unchanged file costs nothing
- [ ] `src/checkpoint/create.ts` - snapshot before each mutating tool call,
      tagged with turn index and tool-call id
- [ ] `src/checkpoint/restore.ts` - restore code to any turn, restore
      conversation to any turn, or both. Writes go through the same
      `confinePath` and the same Phase 11 permission decision as any other write
- [ ] `src/checkpoint/fork.ts` - branch a session from any turn into a new
      session id, sharing nothing mutable
- [ ] Undo of a checkpoint never touches files the agent did not write; Bash
      side effects are explicitly out of scope and documented as such, exactly
      as Claude Code documents it
- [ ] `src/cli/index.ts` - `jaa rewind [turn]`, `jaa fork <id> [turn]`
- [ ] `src/tui/app.tsx` - `Esc Esc` binding, a `/rewind` picker showing the
      turn list with a one-line summary per turn
- [ ] `tests/checkpoint.test.ts` - create/restore round-trip, dedup, traversal
      refusal, fork isolation, and a test proving restore cannot escape the root

**Gate:** `Esc Esc` restores the working tree to a prior turn exactly. Forked
sessions do not share mutable state. Restore of a path outside the root is
refused.

**Risk:** disk growth. Mitigation: hash dedup plus a configurable retention
window, pruned on session close.

---

### Phase 15 - Multi-agent orchestration

**Gap closed:** ranked #4. `jaa agent run` becomes a real orchestrator.

**Competitor parity:** Claude Code subagents + agent view + agent teams +
dynamic workflows + `/batch` worktree fan-out; Codex `max_threads: 6`,
`max_depth`, `spawn_agents_on_csv`, worktree isolation, auto-review; DeepSeek
subagents + workflows + background jobs.

- [ ] `src/orchestrator/task.ts` - `Task` (id, prompt, agent, status, result,
      parent, children), a persisted task board under `~/.jaa/tasks/`
- [ ] `src/orchestrator/pool.ts` - bounded concurrency with configurable
      `max_threads` (default 6) and `max_depth` (default 1, matching Codex's
      conservative default) plus a hard ceiling so a fan-out cannot run away
- [ ] `src/orchestrator/isolation.ts` - git worktree per worker so parallel
      agents never touch the same files; automatic cleanup including the
      failure path, and a clear error when git is unavailable or the repo is
      dirty in a way that blocks worktree creation
- [ ] `src/orchestrator/background.ts` - detached workers that survive the
      parent turn, with `jaa tasks list|attach|stop` and a completion summary
      delivered into the parent transcript
- [ ] `src/orchestrator/team.ts` - peer-to-peer message passing and a shared
      task board across workers, so workers can hand off without the parent
      relaying every message
- [ ] `src/orchestrator/fanout.ts` - CSV and JSONL batch fan-out, one worker
      per row, structured per-row output merged back; the Codex
      `spawn_agents_on_csv` shape
- [ ] `src/orchestrator/review.ts` - an independent reviewer pass over worker
      output before it is accepted, so a worker cannot mark its own homework
- [ ] Subagent declaration upgrades: `model`, `tools`, `disallowedTools`,
      `skills` preload, `maxTurns`, `isolation: worktree`, `background`
- [ ] Output scanning on every subagent report before the parent reads it --
      a subagent that read a hostile file must not be able to inject
      instructions into the parent conversation
- [ ] `tests/orchestrator.test.ts` - concurrency cap, depth cap, worktree
      isolation, background lifecycle, task-board persistence, fan-out merge,
      reviewer independence, injection scan

**Gate:** three agents edit three overlapping files in parallel with zero
conflicts. Depth and thread caps hold under a deliberate fan-out bomb. A
subagent cannot escalate its own permissions. Injected instructions in a
subagent report are neutralized.

**Risk:** token blowup and cost. Codex's own docs warn that deeper recursion
"turns broad delegation instructions into repeated fan-out." Mitigation: the
depth default stays at 1, the thread cap is enforced, and the fan-out tool
requires an explicit opt-in flag.

---

### Phase 16 - Compaction and persistent memory

**Gap closed:** the current `trimToBudget` silently drops context. Competitors
summarize.

**Competitor parity:** Claude Code compacts around 95% and re-reads project
memory from disk afterward so it survives; opencode near 90%; Codex uses
model-native compaction.

- [ ] `src/agent/compact.ts` - summarization compaction at a configurable
      threshold (default 90%), using the same provider adapter as the main loop
      so it works on every provider including local models
- [ ] Preserved verbatim across compaction: the system prompt, project memory
      (`AGENTS.md` and friends), pinned skills, and any user message the user
      marked important. Everything else is replaced by the summary
- [ ] `src/agent/memory.ts` - auto-memory: durable notes the agent writes and
      re-reads on the next session, scoped per project, with a size cap and a
      visible editor (`jaa memory list|edit|clear`) so it is never a hidden
      black box
- [ ] Compaction is observable: `jaa ask` reports tokens before and after, and
      the TUI shows a compaction marker in the transcript
- [ ] `src/cli/index.ts` - `jaa compact [session] [--focus <text>]`
- [ ] `tests/compaction.test.ts` - invariants preserved through compaction,
      budget respected, local-model path, memory persistence and size cap

**Gate:** a session driven past the compaction threshold still retains the
system prompt, project memory, and pinned content, and the token count drops.
Auto-memory survives a process restart.

**Risk:** summarization can lose a detail that mattered. Mitigation: the
preserved list is explicit and tested; the user can pin any turn; compaction
never fires below the threshold.

---

### Phase 17 - Live code intelligence

**Gap closed:** ranked #8. `jaa lsp diagnose` is a manual one-shot command;
competitors feed real diagnostics into the loop.

**Competitor parity:** opencode ships 30+ auto-installing LSP configurations and
queries the server after every edit, feeding results into model context.

- [ ] `src/lsp/registry.ts` - built-in server configs for TypeScript, Python,
      Rust, Go, Java, C/C++, and the rest, auto-detected from the project and
      auto-started on demand. Import opencode's `lsp` config shape
- [ ] `src/lsp/session.ts` - one long-lived client per server instead of a
      process per invocation; reuse the Phase 8 framing and handshake
- [ ] `src/lsp/workspace.ts` - `didOpen` / `didChange` / `didSave` lifecycle so
      the server actually knows the buffer state
- [ ] `src/lsp/features.ts` - diagnostics (on change and on demand),
      definition, references, hover, document symbols, workspace symbols
- [ ] `src/agent/loop.ts` - after a mutating tool call, publish fresh
      diagnostics for touched files into the next turn as a system message, so
      the model sees real compiler errors instead of hallucinating them
- [ ] `src/tools/lsp.ts` - expose the feature set to the agent as tools
      (`lsp_diagnostics`, `lsp_definition`, `lsp_references`, `lsp_hover`)
- [ ] Graceful degradation: no server for the language means no diagnostics
      and no error, reported in `jaa doctor`
- [ ] `tests/lsp-loop.test.ts` - lifecycle, diagnostics injection after edit,
      server crash and restart, timeout, and absence handling

**Gate:** editing a file with a type error surfaces that error to the agent on
the next turn without the model being asked. A crashing language server is
restarted once and then ignored, never fatal.

**Risk:** language servers are heavy and sometimes hang. Mitigation: startup
is lazy and per-project, every request is bounded by a timeout, and a wedged
server is killed and reported rather than allowed to block the loop.

---

### Phase 18 - Compatibility and interop layer

**Gap closed:** the thesis. Full specification is the compatibility matrix
section above; this phase is the implementation of it.

- [ ] `src/compat/detect.ts` - probe every source in the read matrix, record
      path, mtime, size, and precedence rank
- [ ] `src/compat/memory.ts` - merge `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
      `.cursorrules`, `.cursor/rules/*.mdc`, `.windsurfrules`, and
      `.github/copilot-instructions.md` into one attributed project-memory
      block. No silent rewrite; `jaa doctor` prints the full attribution table
- [ ] `src/compat/claude.ts` - `.claude/settings.json` permission rules and
      hook entries; `.claude/agents/*.md` and `.claude/commands/*.md`
- [ ] `src/compat/codex.ts` - minimal TOML reader for `[mcp_servers.*]`,
      `model`, `sandbox_mode` from `~/.codex/config.toml`. A focused parser, not
      a general TOML dependency, unless the gate proves that wrong
- [ ] `src/compat/opencode.ts` - `mcp`, `plugin`, `instructions`,
      `permission`, and `agent` from `opencode.json` at both project and global
      scope. Plugin *files* are listed, never executed
- [ ] `src/compat/mcpjson.ts` - Claude Code `.mcp.json` -> jaa MCP clients
- [ ] `src/compat/sync.ts` - `jaa compat sync`: generate `AGENTS.md` (guarded),
      `CLAUDE.md`, and `.mcp.json`. Refuses to overwrite hand-written content
      without `--force`, and writes a `.jaa/compat-manifest.json` recording what
      it generated so a later sync can update rather than duplicate
- [ ] `src/compat/print.ts` - `jaa compat print <codex|opencode|claude|all>`
      emits ready-to-paste config to stdout
- [ ] `src/compat/export.ts` - `jaa exec --output json|stream-json`, exit codes
      `0/1/2/3`, and `jaa agent export` to `.claude/agents/*.md` and
      `.codex/agents/*.toml`
- [ ] `tests/fixtures/multi-harness-repo/` - a fixture repository containing
      every read-matrix file
- [ ] `tests/compat.test.ts` - one test per numbered acceptance assertion in
      the matrix, plus precedence-order tests and a no-clobber test

**Gate:** the five acceptance assertions in the matrix section all pass against
the fixture repository with zero jaa-specific configuration.

**Risk:** precedence surprises. A user may expect `CLAUDE.md` to win because
that is their daily driver. Mitigation: precedence is documented, printed by
`jaa doctor`, and overridable with an explicit `jaa` config key.

---

### Phase 19 - Plugin system and registry

**Gap closed:** ranked #7. Skills and subagents cannot currently be bundled and
distributed as one unit.

**Competitor parity:** Claude Code plugin manifests bundling skills, agents,
hooks, MCP servers, LSP servers, output styles, themes, and `bin`; Codex
marketplace with 90+ first-party plugins; DeepSeek's everything-is-a-plugin
Cordis model; opencode's `plugin` array.

- [ ] `src/plugins/manifest.ts` - `jaa-plugin.json` schema: `name`, `version`,
      `description`, `author`, `homepage`, `repository`, `license`, and
      component paths for `skills`, `agents`, `hooks`, `mcpServers`,
      `lspServers`, `themes`, `bin`. Read `.claude-plugin/plugin.json` too, so
      Claude Code plugins install directly
- [ ] `src/plugins/install.ts` - install from a local path, a git URL, or an
      npm tarball; verify the manifest before writing; atomic install with
      rollback on failure
- [ ] `src/plugins/load.ts` - layered load: global then project, later layers
      merge by name. Namespaced agent and skill ids (`plugin-name:skill-name`)
      so two plugins cannot collide
- [ ] `src/plugins/registry.ts` - discovery, search, install, remove, enable,
      disable, update. Local and remote catalogs
- [ ] `src/plugins/bin.ts` - plugin-provided executables added to the Bash
      tool's `PATH` for the session only, never to the user's shell profile
- [ ] Security: plugin code is executable. Plugin-provided tools, hooks, and
      agents are subject to the Phase 11 permission engine and the Phase 12
      sandbox. A plugin cannot widen permissions. Installing a plugin from an
      untrusted source prints exactly what it will execute and requires
      confirmation
- [ ] `src/cli/index.ts` - `jaa plugin list|search|install|remove|enable|
      disable|update|inspect`
- [ ] `tests/plugins.test.ts` - manifest validation, layered merge, namespacing,
      install rollback, PATH scoping, and a test proving a plugin cannot escalate
      permissions

**Gate:** a Claude Code plugin with skills, agents, and an MCP server installs
into jaa and all three components work. Two plugins with colliding skill names
coexist. A plugin cannot grant itself a permission the session does not have.

**Risk:** this is the largest new attack surface in the roadmap. Mitigation:
Phase 11 and 12 are hard prerequisites, plugin install is explicit and
inspectable, and `bin` injection is session-scoped.

---

### Phase 20 - TUI overhaul

**Gap closed:** ranked #6. The most visible surface is the least developed, and
it is the last phase so it can render everything the previous nine built.

**Competitor parity:** Codex's Rust TUI with vim motions, `/export`, session
picker, agent dashboard, and cost-aware status line; opencode's Go TUI with
themes, keybinds, and attention notifications; DeepSeek's typed tool cards.

- [ ] `src/tui/cards.ts` - typed result cards, following DeepSeek's model
      because it is the best of the four: `diff` (inline hunks for every
      mutation), `terminal` (command, cwd, live output, exit code), `search`
      (grouped matches with truncated/total so a capped result never reads as
      complete), `web`, and `generic`. Every card carries `locations` so an
      editor can follow along
- [ ] `src/tui/layout.tsx` - multi-pane: transcript, tool activity, subagent
      tree, and a dockable task board. Pane focus, split, and resize on
      `Ctrl-p`
- [ ] `src/tui/dashboard.tsx` - the agent dashboard: every live subagent with
      state, current tool, elapsed time, and token spend. Attach, steer, and
      stop from the dashboard
- [ ] `src/tui/permissions.tsx` - an inline approval prompt rendered as a
      first-class card showing the exact command, the rule that matched, and
      the decision options
- [ ] `src/tui/themes.ts` - themeable color tokens, light and dark, with a
      `~/.jaa/theme.json` override; respect `NO_COLOR` and
      `prefers-reduced-motion`
- [ ] `src/tui/keybinds.ts` - configurable keymap with a discoverable palette
- [ ] `src/tui/motions.tsx` - vim motions in the composer; expand and collapse;
      incremental streaming render
- [ ] `src/tui/export.ts` - `/export` to Markdown, including tool calls, diffs,
      and the compaction markers
- [ ] Accessibility: full keyboard reachability, visible focus, correct ARIA,
      a screen-reader-friendly non-visual transcript mode, and no information
      conveyed by color alone
- [ ] `tests/tui/*.test.tsx` - card rendering per type, approval flow, dashboard
      lifecycle, theme override, keymap override, export fidelity, and an
      automated axe pass on the non-interactive transcript view

**Gate:** a full session -- subagents, approvals, diffs, a compaction event, a
crashed tool -- renders correctly with no layout corruption at 80x24 and at
200x60. Every action is reachable by keyboard alone. The axe pass reports zero
serious violations.

**Risk:** Ink is a React renderer for a terminal, and heavy live updates can
drop frames. Mitigation: incremental rendering with bounded update frequency,
a frame budget, and a headless render test that asserts update counts.

---

## Deferred past Phase 20

Recorded so they are not lost, explicitly not in the competitive-core scope:

- Code Mode -- a model-generated TypeScript program that orchestrates many tool
  rounds in one call. This is DeepSeek's genuine innovation and the one place
  jaa would need to out-invent rather than out-ship. Highest-value Phase 21.
- Background and scheduled execution -- durable jobs, wakeup scheduling, a
  GitHub Action, cost and status lines.
- Provider depth -- OAuth subscription auth for Claude Pro/Max and ChatGPT
  Plus, the OpenAI Responses API, per-model reasoning-effort control, and
  prompt-cache accounting.
- Plugin themes as a distributable marketplace entry.
- A web and IDE client, if the client-server split is ever worth the cost.

## Definition of done for phases 11-20

Every phase gate, pasted with real output:

```
npm run lint
CI=1 npm test
npm run build
npm audit --audit-level=high
npx playwright test --config=tests/e2e/playwright.config.ts   # when e2e exists
npx wrangler deploy --dry-run                                  # N/A for jaa
```

Plus, for the roadmap as a whole:

- `jaa bench` shows jaa at or above the best competitor on every tag, or the
  specific tags where it loses are named with the reason.
- The Phase 18 fixture repository passes all five acceptance assertions.
- `jaa doctor` runs clean on Linux, macOS, and Windows and names the active
  sandbox mechanism on each.

Report format is unchanged: SUMMARY, FILES, PACKAGES, COMMANDS, METRICS, RISKS,
FINDINGS, BLOCKED. Intended behavior is never reported as verified.

## Tools commands (Windows note)
PowerShell: `rg` NOT on PATH; use the grep/glob session tools or
PowerShell `[regex]` over `[IO.File]::ReadAllText` for huge JSON lines.