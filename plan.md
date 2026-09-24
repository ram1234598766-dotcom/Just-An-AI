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
| 1 | Config + keyring (`~/.jaa`, env precedence, `key/config/setup/doctor`) | `phase/1-config` | in progress |
| 2 | Provider adapters (openai-compatible, anthropic, gemini, ollama) + router | `phase/2-providers` | pending |
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
- [ ] `src/config/paths.ts`: `~/.jaa` layout (root, sessions, skills, cache, `.env`)
- [ ] `src/config/env.ts`: precedence process env > project `.env` > `~/.jaa/.env`; `JAA_` namespace + provider-key mapping
- [ ] `src/config/keyring.ts`: `jaa key set/list/remove`, masked output, mode-restricted file (0600 / Windows ACL best-effort)
- [ ] `src/config/settings.ts`: typed settings (zod), `jaa config get/set`
- [ ] `src/config/setup.ts`: interactive wizard (provider pick → paste key → persist) + `jaa setup --no-interactive`
- [ ] bootstrap `~/.jaa` on first command
- [ ] tests: precedence, masking, persist/read round-trip (temp dirs)

## Tools commands (Windows note)
PowerShell: `rg` NOT on PATH; use the grep/glob session tools or
PowerShell `[regex]` over `[IO.File]::ReadAllText` for huge JSON lines.