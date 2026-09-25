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

Under construction — see `plan.md` for the phase tracker. Phase 8 (MCP/LSP) and
Phase 9 (eval harness + packaging) are complete.

## Node

Node >= 22. Builds with TypeScript (strict), tests with Vitest.

```bash
npm ci            # install
npm run lint      # tsc --noEmit (the type gate)
npm test          # vitest run
npm run build     # tsc → dist/
```

## Eval harness

`jaa eval` runs the built-in seed tasks (or a directory of JSON task files) and
reports `pass@1` and `pass@N` metrics plus token usage. Every task declares
checks (contains, notContains, toolCalled, fileExists, stopReasonIs) that run
against the agent's transcript.

```bash
jaa eval                        # seed tasks
jaa eval --provider ollama --model llama3.2:3b
jaa eval --tasks ./my-tasks    # JSON task files
jaa eval --retries 2 --json    # machine-readable output
```

## Packaging

The published package ships only `dist/`, `README.md`, `LICENSE`, and `plan.md`.
The `jaa` bin points at `dist/cli/index.js`. `npm pack --dry-run` verifies the
whitelist before a release.