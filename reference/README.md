# J.A.A. — Just An AI Assistant

A free, local-first AI coding assistant. J.A.A. runs on your machine with
[Ollama](https://ollama.com) — no API keys, no subscriptions, and your code
never leaves your computer. It combines an agentic coding loop, codebase-aware
memory, desktop automation, system monitoring, and optional voice control.

## Features

- **Agentic coding** — the code agent reads files, edits, and runs commands in
  a real tool-use loop (results are fed back to the model so it can iterate),
  then verifies and tests its own changes.
- **Local-first LLM routing** — defaults to free local models for coding,
  general chat, and reasoning; falls back to any cloud provider you configure
  a key for (OpenAI, Anthropic, OpenRouter, or any OpenAI-compatible endpoint).
- **Cloud keys welcome** — set `JAA_LLM_OPENAI_API_KEY`, `JAA_LLM_ANTHROPIC_API_KEY`,
  `JAA_LLM_OPENROUTER_API_KEY`, or a custom `JAA_LLM_COMPATIBLE_BASE_URL` +
  `JAA_LLM_COMPATIBLE_API_KEY` (LM Studio, vLLM, Together, Groq, DeepSeek, ...).
- **Global agent skills** — search GitHub for agent-skill repos and install
  them once into `~/.jaa/skills`; J.A.A. surfaces them in its system prompt.
- **Persistent sessions** — conversations are saved to `~/.jaa/memory/sessions.db`
  as you chat, so `jaa chat --resume` picks up right where you left off.
- **Token-efficient sessions** — tool outputs are capped, conversation history
  is auto-summarized past a budget, and the tool loop trims oldest messages so
  long sessions stay inside the context window.
- **Codebase memory** — optional vector index of your project so coding tasks
  get relevant existing code as context.
- **Multi-agent** — code, desktop automation, system info, and tool-calling
  agents behind one orchestrator.
- **MCP server** — connect from VS Code, Cursor, or other MCP clients.
- **REST API** — script J.A.A. from anything: `GET /health`, `GET /v1/models`, `POST /v1/chat`, `POST /v1/code`, `POST /v1/memory/search` (stdlib-only, no extra deps).
- **Voice mode** — wake-word, speech-to-text, and text-to-speech (optional).

## Requirements

- Python 3.10+
- [Ollama](https://ollama.com) running locally (default `http://localhost:11434`)

## Install

```bash
pip install -e .          # base install
pip install -e ".[dev]"   # + dev/test tooling
pip install -e ".[memory]"   # + vector memory (chromadb, sentence-transformers)
pip install -e ".[voice]"    # + voice pipeline
pip install -e ".[cloud]"    # + cloud provider SDKs (OpenAI, Anthropic, Google, OpenRouter)
pip install -e ".[automation]"  # + desktop automation
```

## Setup

Pull the recommended local models (tuned for ~8 GB VRAM by default):

```bash
jaa setup
```

This checks that Ollama is running and pulls the models J.A.A. needs. You can
override the model set with the `JAA_LLM_LOCAL_MODELS` env var, for example:

```bash
JAA_LLM_LOCAL_MODELS='{"coder":"qwen3-coder:30b","general":"qwen3:14b","reasoning":"qwen3:8b","embed":"nomic-embed-text:latest"}' jaa setup
```

Run `jaa doctor` any time to check your environment.

## Using your own cloud API keys

J.A.A. uses **whatever keys you provide** - nothing is hardcoded. Give it your
keys and it will use them as fallbacks when local models aren't available or
you prefer cloud quality:

```bash
jaa key set openrouter sk-or-v1-...      # one key, hundreds of models
jaa key set anthropic sk-ant-...
jaa key set openai sk-...
jaa key set google AIza...
jaa key set compatible <key>             # any OpenAI-compatible API
jaa key url https://api.groq.com/openai/v1   # base URL for the compatible provider
jaa key list                             # see what's configured (masked)
jaa key remove openrouter                # remove a key
```

Keys are stored in your own `~/.jaa/.env` (mode 600 on Unix) and are read on
every run - from anywhere, not just the project directory. Precedence:
shell environment variables > project `.env` > `~/.jaa/.env`.

By default J.A.A. prefers local models (`JAA_LLM_PREFER_LOCAL=true`). Set it
to `false` to prefer your cloud models first:

## Usage

```bash
jaa                      # interactive chat
jaa chat "Refactor my auth module to use dependency injection"
jaa chat "Debug why my tests are failing" --project /path/to/project
jaa chat --resume        # continue the most recent session for this project
jaa chat --session demo  # resume (or start) a named session
jaa chat --list-sessions # list saved sessions
jaa analyze              # summarize a project tree
jaa index                # index the codebase for retrieval-augmented coding
jaa setup                # check Ollama + pull recommended models
jaa doctor               # environment health checks
jaa serve                # start the MCP server for IDE integration
jaa api                  # start the REST API (GET /health, POST /v1/chat, ...)
jaa voice                # voice interaction mode
jaa skill search <topic> # find agent-skill repos on GitHub
jaa skill install owner/repo   # install a skill repo globally
jaa skill list           # list installed skills
```

### Example prompts

- "Create a Python function to parse JSON with validation"
- "Refactor `src/main.py` to use async/await"
- "Debug the failing test in `tests/test_api.py`"
- "Organize my downloads folder"
- "What's my CPU usage?"
- "Search the web for the latest AI news"

## Configuration

All settings are configurable via environment variables (`JAA_` prefix) or a
`.env` file. Run `jaa config` to see the active configuration.

| Area | Env prefix | Key defaults |
| --- | --- | --- |
| LLM | `JAA_LLM_` | coder: `qwen2.5-coder:7b`, general: `qwen3:8b`, reasoning: `qwen3:4b`, embed: `nomic-embed-text:latest` |
| Cloud keys | `JAA_LLM_` | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `COMPATIBLE_BASE_URL` + `COMPATIBLE_API_KEY` |
| Skills | `JAA_SKILLS_DIR` | `~/.jaa/skills` |
| Agent | `JAA_AGENT_` | max 10 iterations, auto-test off |
| Security | `JAA_SECURITY_` | shell commands allow-listed, `rm`/`sudo`/network tools blocked |
| Memory | `JAA_MEMORY_` | chromadb at `~/.jaa/chromadb` |

## Project layout

```
jaa/
  agents/       code, desktop, system, and tool agents
  cli/          click-based CLI (chat, setup, doctor, serve, voice)
  config/       pydantic-settings configuration
  core/         compatibility shims
  integrations/ MCP server
  llm/          provider orchestration (Ollama + optional cloud fallbacks)
  memory/       vector store, session memory, codebase indexer
  nlp/          intent classification and command parsing
  voice/        STT/TTS pipeline
  utils/        shared helpers
```

## License

MIT
