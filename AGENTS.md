# AGENTS.md

## Project: jaa — Just An AI

A local-first, multi-provider terminal coding agent shipped as the npm package
`jaa-cli` (bin: `jaa`). Bring your own key from any provider (OpenAI, Anthropic,
Google, Groq, DeepSeek, Mistral, Together, xAI, Azure, Ollama), or run fully
local on Ollama. Written in TypeScript, targets Node 26+, strict tsconfig, no
secrets ever baked into the repo.

## Stack

- **Language**: TypeScript 5 + Node 26, ES modules, `verbatimModuleSyntax`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **Build**: `tsc -p tsconfig.build.json` → `dist/`. `npm run lint` = `tsc --noEmit`.
- **Test**: Vitest (`vitest run`), `tests/` folder. Use `mkdtempSync` + `JAA_HOME`
  override for filesystem tests.
- **CLI**: Commander.js (`src/cli/index.ts`). One `Command` per subcommand group.
- **Providers**: OpenAI-compatible SDK family, Anthropic SDK, Google GenAI, Ollama.
  All adapters implement the `ProviderAdapter` interface from `src/providers/types.ts`.
- **Agent loop**: `src/agent/loop.ts` — `runAgentLoop`. Context trimmed per-request
  via `trimToBudget` (32 000 default). Full transcript always returned.
- **Tools**: `src/tools/` — `fs`, `patch`, `bash` (gated by `allowBash`), `web`,
  `git` (read-only). All paths confined to workspace root via `confinePath`.
- **Config**: `~/.jaa/` (`config.json`, `.env` for keys mode 0600 on POSIX,
  `sessions/`, `cache/`, `skills/`). Precedence: process env > project `.env` >
  `~/.jaa/.env`.
- **Skills**: `~/.jaa/skills/<id>/SKILL.md` with YAML frontmatter (`name`,
  `description`, `triggers`) + markdown body. Autotriggered on `ask`/`chat`.
  See `src/skills/`.

## Conventions

- Import paths use `.js` extension even for `.ts` files (ESM + tsx).
- Strict typing: no `any`, no non-null assertions as silencers, no `@ts-ignore`.
- Treat all external input as hostile: validate at boundaries, sanitize HTML.
- Heavy modules (CodeMirror, xterm, transformers, firebase) stay dynamically
  imported and client-only in VantaOS; in jaa, provider SDKs are statically
  imported but the TUI (ink) is dynamically loaded in `jaa chat`.
- Tests must not touch the real `~/.jaa` — always override `JAA_HOME`.
- **Single branch: `main` only.** All work is committed and pushed directly to
  `main`. Do not create `phase/<n>-<slug>` branches or any other feature branch.
  Conventional commits, one logical change each, so history stays legible without
  branch separation.
- No ESLint — `tsc --noEmit` is the type gate.

## Subagents

### code-reviewer
- **Description**: Reviews code for correctness, security, and style
- **Ownership**: `src/**/*.ts`, `src/**/*.tsx`, `tests/**/*.ts`, `tests/**/*.tsx`
- **Deps**: lint, build
- **Acceptance**: `npm run lint` exits 0, all tests pass, no new security issues
- **Instructions**: Review the provided diff for logic bugs, type-safety violations, security issues (path traversal, secret leakage, command injection), and style violations. Verify TypeScript strict mode compliance. Check that all new code has corresponding tests. Flag any non-null assertions, `@ts-ignore`, or `any` usage.

### test-writer
- **Description**: Writes and maintains unit and integration tests
- **Ownership**: `tests/**/*.ts`, `tests/**/*.tsx`
- **Deps**: code-reviewer
- **Acceptance**: All tests pass (`CI=1 npm test`), new code has >= 80% branch coverage, edge cases covered
- **Instructions**: For any new or modified code, write focused Vitest tests. Use `mkdtempSync` + `JAA_HOME` override for filesystem tests. Use fake adapters for provider tests. Ensure the test file covers edge cases, error paths, and validation boundaries. Follow existing test patterns in `tests/`.

### docs-updater
- **Description**: Keeps README.md and plan.md in sync with the codebase
- **Ownership**: `README.md`, `plan.md`
- **Deps**: none
- **Acceptance**: `README.md` and `plan.md` accurately reflect the current code and commands
- **Instructions**: After any feature work, update the relevant documentation. `plan.md` tracks per-phase progress and gate results. `README.md` documents installation, usage, and provider setup. Never expose secrets in documentation. Keep the status board in `plan.md` current.
