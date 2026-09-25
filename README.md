# J.A.A. -- Just An AI

A local-first, multi-provider terminal coding agent. Bring your own API key from
**any** provider, or run fully local on Ollama -- then let the built-in eval
harness prove the results.

`jaa` is a globally installable npm CLI: `npm i -g jaa-cli`.

## Why jaa exists

Claude Code, Codex, and opencode each do some things great. jaa is built to be
the superset: every provider, local-first, a modern TUI plus scriptable
non-interactive mode, subagents, skills, MCP, sessions, sandboxed tools -- and a
measurable bar (`jaa eval`) so "better" is tested, not claimed.

## Status

Production. All phases 0-9 complete and gated; published to npm as `jaa-cli@0.1.0`.
Phase 10 (head-to-head benchmark) is on hold with the owner. See `plan.md`.

## Node

Node >= 22. Builds with TypeScript (strict), tests with Vitest.

```bash
npm ci            # install
npm run lint      # tsc --noEmit (the type gate)
npm test          # vitest run
npm run build     # tsc -> dist/
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

## Bench harness

`jaa bench` runs the same cases through jaa and any installed reference
harnesses, so "better" is a number rather than a claim. 46 cases across 10
tags: edit, refactor, debug, test-gen, multi-file, tool-use, long-context,
instruction-following, refusal, injection-resistance.

```bash
jaa bench --list                        # list cases and tags
jaa bench                               # all cases, jaa only
jaa bench --tags debug,refusal          # filter by tag
jaa bench --harness jaa,codex,claude    # cross-harness parity
jaa bench --out results.ndjson          # persist + resume (skips recorded cases)
jaa bench --report RESULTS.md           # write a Markdown report
jaa bench --json                        # machine-readable
```

Competitor binaries are optional. `claude`, `codex`, `opencode`, and `dsh` are
detected on PATH; a missing one is reported as **skipped**, never as a failure,
and a matrix with only jaa still runs. Results stream to NDJSON after every
case, so an interrupted run resumes where it stopped.

Each case declares checks over the transcript, the work tree, and the tool
calls: `fileExists`, `fileContains`, `fileAbsent`, `finalContains`,
`finalMatches`, `toolCalled`, `notToolCalled`, `turnsAtMost`, `touched`,
`untouched`, `noError`. Cases run in a throwaway directory that is removed
afterwards, so a bad case cannot damage your repo.

## Permissions

Every tool call — in `ask`, `chat`, and `agent run` — passes a policy engine
before it runs. A denial is returned to the model as a result string, so the
agent can recover instead of crashing.

```bash
jaa perm list                                    # every effective rule, with its source
jaa perm list --mode full-auto
jaa perm test bash '{"command":"rm -rf /"}'      # evaluate a call without running it
echo '{"command":"git status"}' | jaa perm test bash   # stdin avoids shell quoting
jaa perm list --trust-project-settings           # also honour .claude/settings.json
```

**Modes.** `suggest` (default) asks for anything not explicitly allowed.
`auto-edit` allows read-only tools and asks about writes. `full-auto` allows
known writes. **Bash is never implicitly allowed in any mode** — shell access
always needs an explicit rule or an explicit operator decision. A tool jaa does
not itself register (anything an MCP server advertises) also gets no mode
baseline, because jaa cannot know what it does.

**Rules** live in `~/.jaa/config.json` and may combine `tool`, `command`, and
`path`. The most specific match wins, and **deny is absolute** — no allow can
override it.

```json
{
  "permissions": {
    "mode": "auto-edit",
    "allow": [{ "tool": "bash", "command": "git status" }],
    "deny": [{ "path": ".env" }, { "command": "git push" }]
  }
}
```

A bare string is a **tool name**, not a path: `"deny": [".env"]` matches no
tool and does nothing. Use `{ "path": ".env" }`. `jaa perm list` warns about
any deny rule that can never fire.

**Fail-closed by construction.** A command containing a shell operator
(`&&`, `;`, `|`, backtick, `$(`, redirect, newline) is never claimed by a
prefix rule, so an allow on `git status` cannot be widened to
`git status && rm -rf /`. Prefix comparison is whitespace-normalised and
case-insensitive. Path rules match the resolved root-relative path, so `./`,
`../`, absolute, and case-variant spellings all hit the same rule. In a
non-interactive session an `ask` becomes a `deny` rather than a hang.

**Project policy is not trusted.** A `.claude/settings.json` in the working
directory is detected and reported, but not applied unless you pass
`--trust-project-settings`: that file lives inside a cloned repository, so
honouring it automatically would let the repository widen your permissions.

**A malformed config warns and fails closed.** Each permission field is
validated independently, so a typo in `allow` can no longer silently void your
`deny` list.

## Quickstart

```bash
npm i -g jaa-cli
jaa setup            # interactive: pick a provider, paste your key
jaa doctor           # verify node/git/tmp + provider status
jaa ask "fix the typo in src/foo.ts"
jaa chat             # interactive Ink TUI
```

Keys live only in `~/.jaa/.env` (mode 0600 on POSIX) or environment variables.
Precedence: process env > project `.env` > `~/.jaa/.env`. Local providers
(ollama) never need a key.

## Commands

| Command | Purpose |
|---------|---------|
| `jaa ask "<prompt>"` | One-shot agent run (optionally `--save`, `--resume`, `--provider`, `--model`, `--max-turns`, `--token-budget`, `--temperature`, `--ctx`, `--no-tools`, `--no-bash`, `--no-skills`) |
| `jaa chat` | Interactive Ink TUI |
| `jaa session list|show|remove` | Conversation history |
| `jaa agent list|show|run <name> [task]` | Subagents defined in `AGENTS.md` |
| `jaa skill list|install|remove` | `SKILL.md` skills with autotrigger |
| `jaa key set|list|remove <provider>` | Keyring (output masked as `****<last4>`) |
| `jaa config get|set|list <path>` | Settings |
| `jaa setup [--provider X --key Y -y]` | First-run wizard |
| `jaa doctor` | Environment diagnostics |
| `jaa mcp serve [--allow-bash]` | Expose jaa tools as an MCP stdio server |
| `jaa lsp diagnose` | LSP diagnostics |
| `jaa perm list|test` | Inspect the effective permission policy |
| `jaa eval [options]` | Eval harness |
| `jaa bench [options]` | Parity benchmark across harnesses |

## Tools

Sandboxed, workspace-confined. All paths are checked against the workspace
root by `confinePath` (absolute paths and `..` traversal blocked, null-byte
guard). Output is clamped to 80 KB per tool result.

| Tool | Description |
|------|-------------|
| `read_file` | Binary sniff, truncated at cap |
| `write_file` | Atomic write |
| `list_dir` | Directory listing |
| `stat` | File metadata |
| `glob` | `*`/`?`/`**` patterns, workspace-only, 500-entry cap |
| `patch` | Exact-anchor hunks, applied atomically (<=20 hunks) |
| `bash` | Gated behind `allowBash`; `sh -c`/`cmd /d /s /c`, 30s default (cap 120s), no shell injection via `execFile` |
| `fetch_url` | http(s) only, redirect-following, body capped |
| `git_status`/`git_log`/`git_diff`/`git_show` | Read-only, run as `git -C <root>` |

## Providers

OpenAI-compatible family (OpenAI, Groq, DeepSeek, Mistral, Together, xAI, Azure,
local vLLM/LM Studio), Anthropic, Google GenAI, and Ollama (local-first, no key).
All adapters implement the neutral `ProviderAdapter` interface.

## Subagents

Defined in `AGENTS.md` under `## Subagents`. Each declares ownership, deps, and
acceptance criteria. `jaa agent run <name> "<task>"` runs one with bash gated off
by default.

## Skills

`~/.jaa/skills/<id>/SKILL.md` with YAML frontmatter (`name`, `description`,
`triggers`). Autotriggered on `ask`/`chat` by case-insensitive substring match.
Installable from GitHub (`git clone --depth 1`) or a raw URL.

## MCP / LSP

`jaa mcp serve` exposes jaa's tools over MCP stdio (newline-delimited JSON
framing, proper `initialize`/`initialized` handshake, `-32002` before init,
`-32602` invalid params, `isError` on tool failures). `--mcp-server` is
repeatable; `--no-tools` and `--allow-bash` are available. LSP uses separate
`Content-Length` framing with extra-header support.

## Sessions

One JSON file per session under `~/.jaa/sessions/`. Zod-validated on every read
(disk is hostile), atomic writes (tmp + rename), id `s-<base36 ts>-<hex>`
guarded against path traversal, titles derived from the first user message.

## Packaging

The published package ships only `dist/`, `README.md`, `LICENSE`, and `plan.md`.
The `jaa` bin points at `dist/cli/index.js`. `npm pack --dry-run` verifies the
whitelist before a release (172 files, 102.4 kB tarball).

## Development

```bash
npm ci
npm run lint      # tsc --noEmit, strict
npm test          # vitest run, 161/161 across 16 files
npm run build     # tsc -> dist/
npm run eval      # jaa eval
```

No secrets are ever baked into the repo or the package. `.gitignore` excludes
`*.env*` (except `.env.example`), `*.key`, `*.pem`. Structured logs never contain
key material; keyring output masks values.