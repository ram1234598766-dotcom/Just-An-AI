# J.A.A. — Just An AI

A local-first, multi-provider terminal coding agent. Bring your own API key from
**any** provider, or run fully local on Ollama — then let the built-in eval
harness prove the results.

`jaa` is a globally installable npm CLI: `npm i -g jaa-cli`.

## Why jaa exists

Claude Code, Codex, and opencode each do some things great. jaa is built to be
the superset: every provider, local-first, a modern TUI plus scriptable
non-interactive mode, subagents, skills, MCP, sessions, sandboxed tools — and a
measurable bar (`jaa eval`) so "better" is tested, not claimed.

## Status

Under construction — see `plan.md` for the phase tracker. Phase 0 (repo + CLI
skeleton) is the current checkpoint.

## Node

Node >= 22. Builds with TypeScript (strict), tests with Vitest.

```bash
npm ci            # install
npm run lint      # tsc --noEmit (the type gate)
npm test          # vitest run
npm run build     # tsc → dist/
```