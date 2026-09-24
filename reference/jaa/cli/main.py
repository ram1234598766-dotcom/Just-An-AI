"""
Main CLI entry point for J.A.A.
"""

from __future__ import annotations

import os
import warnings

warnings.filterwarnings("ignore", message=".*Pydantic V1 functionality.*")
warnings.filterwarnings("ignore", message=".*LangChainPendingDeprecationWarning.*")
warnings.filterwarnings("ignore", message=".*The default value of `allowed_objects`.*")

os.environ.setdefault("TQDM_DISABLE", "1")

import asyncio
import logging
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from rich.markdown import Markdown
from rich.spinner import Spinner
from rich.live import Live
from rich.rule import Rule

from jaa.config.settings import Settings, get_settings, reload_settings
from jaa.core.orchestrator import JAAOrchestrator
from jaa.utils import setup_logging

console = Console()


def setup_cli_logging(level: str) -> None:
    """Setup logging for CLI."""
    # Ensure Unicode (✓/✗/emoji) can be printed even on legacy Windows codepages
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    settings = get_settings()
    settings.log_level = level
    settings.debug = level == "DEBUG"
    setup_logging(level=level, log_file=settings.data_dir / "logs" / "jaa.log")


@click.group(invoke_without_command=True)
@click.option("--config", "-c", type=click.Path(exists=True), help="Config file path")
@click.option("--log-level", "-l", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
@click.option("--project", "-p", type=click.Path(exists=True, file_okay=False), help="Project root directory")
@click.option("--debug/--no-debug", default=False, help="Enable debug mode")
@click.pass_context
def main(ctx: click.Context, config: str | None, log_level: str, project: str | None, debug: bool) -> None:
    """J.A.A. - Just An AI Assistant

    A powerful multi-modal AI assistant combining code intelligence,
    desktop automation, and voice control.
    """
    ctx.ensure_object(dict)
    ctx.obj["config"] = config
    ctx.obj["project"] = project
    ctx.obj["debug"] = debug

    setup_cli_logging(log_level)

    if debug:
        import os
        os.environ["JAA_DEBUG"] = "1"

    # Show banner if no subcommand
    if ctx.invoked_subcommand is None:
        show_banner()
        ctx.invoke(chat)


def show_banner() -> None:
    """Display J.A.A. banner."""
    banner = Text()
    banner.append("██████████████████████████████████████████████████████████\n", style="bold cyan")
    banner.append("█                                                      █\n", style="cyan")
    banner.append("█   J . A . A .   -   Just An AI Assistant            █\n", style="bold white on cyan")
    banner.append("█                                                      █\n", style="cyan")
    banner.append("█   Code Intelligence  |  Desktop Automation          █\n", style="dim white")
    banner.append("█   Voice Control      |  Local-First Privacy         █\n", style="dim white")
    banner.append("█                                                      █\n", style="cyan")
    banner.append("██████████████████████████████████████████████████████████\n", style="bold cyan")

    panel = Panel(banner, border_style="cyan", padding=(0, 1))
    console.print(panel)
    console.print()


@main.command()
@click.argument("message", required=False)
@click.option("--voice", "-v", is_flag=True, help="Use voice mode")
@click.option("--stream/--no-stream", default=True, help="Stream response")
@click.option("--resume", is_flag=True, help="Continue the most recent session for this project")
@click.option("--session", "session_id", default=None, help="Resume (or create) a named session")
@click.option("--list-sessions", is_flag=True, help="List saved sessions for this project and exit")
@click.pass_context
def chat(ctx: click.Context, message: str | None, voice: bool, stream: bool, resume: bool, session_id: str | None, list_sessions: bool) -> None:
    """Chat with J.A.A. (interactive if no message provided)."""
    project_root = Path(ctx.obj["project"]) if ctx.obj.get("project") else Path.cwd()

    async def _chat():
        orchestrator = JAAOrchestrator(project_root)
        await orchestrator.initialize()
        try:
            conversation = orchestrator.conversation

            if list_sessions:
                sessions = conversation.list_sessions()
                if not sessions:
                    console.print("[yellow]No saved sessions for this project yet.[/yellow]")
                    return
                console.print(f"[bold]{len(sessions)} session(s) for {project_root}:[/bold]\n")
                for s in sessions:
                    when = __import__("datetime").datetime.fromtimestamp(s["updated_at"]).strftime("%Y-%m-%d %H:%M")
                    console.print(f"  • [bold]{s['id']}[/bold]  {when}")
                    console.print(f"      resume: jaa chat --resume --session {s['id']}")
                return

            loaded_id = None
            if session_id:
                if conversation.load(session_id):
                    loaded_id = session_id
                else:
                    conversation.session_id = session_id  # fresh named session
            elif resume:
                latest = conversation.load_latest()
                if latest and conversation.load(latest):
                    loaded_id = latest
            if loaded_id:
                console.print(f"[dim]Resumed session {loaded_id}[/dim]")

            if message:
                # Single message mode
                with console.status("[bold cyan]Thinking...", spinner="dots"):
                    full_response = await orchestrator.process_text(message, voice_mode=voice)
                console.print("[bold green]J.A.A.:[/bold green] ", end="")
                console.print(Markdown(full_response))
            else:
                # Interactive mode
                console.print("[dim]Interactive mode. Type 'exit' or 'quit' to leave, 'help' for commands.[/dim]\n")
                while True:
                    try:
                        user_input = console.input("[bold blue]You:[/bold blue] ")
                        if user_input.lower() in ("exit", "quit", "bye"):
                            console.print("[dim]Goodbye![/dim]")
                            break

                        if user_input.lower() in ("help", "?"):
                            _print_help()
                            continue

                        if not user_input:
                            continue

                        # Stream into a live markdown view (no double-printing,
                        # no clashing with a status spinner).
                        full_response = ""
                        with Live(Markdown(""), console=console, refresh_per_second=12, transient=True) as live:
                            async for chunk in orchestrator.process_text_stream(user_input, voice_mode=voice):
                                full_response += chunk
                                live.update(Markdown(full_response))

                        console.print("[bold green]J.A.A.:[/bold green]")
                        console.print(Markdown(full_response))
                        console.print()

                    except KeyboardInterrupt:
                        console.print("\n[dim]Goodbye![/dim]")
                        break
                    except EOFError:
                        break
        finally:
            await orchestrator.shutdown()

    asyncio.run(_chat())


def _print_help() -> None:
    """Print help message."""
    help_text = """
Available Commands:
  help, ?          - Show this help
  exit, quit, bye  - Exit J.A.A.
  voice            - Switch to voice mode
  clear            - Clear conversation history
  memory           - Show memory stats
  status           - Show system status
  code <task>      - Code assistance
  desktop <action> - Desktop automation
  file <action>    - File operations
  system <query>   - System information

Examples:
  "Create a Python function to parse JSON"
  "Open VS Code"
  "Organize my downloads folder"
  "What's my CPU usage?"
  "Explain this code file"
  "Search the web for latest AI news"
  "What are the fundamental rights under Indian Constitution?"
"""
    console.print(help_text)


@main.command()
@click.pass_context
def voice(ctx: click.Context) -> None:
    """Start voice interaction mode."""
    project_root = Path(ctx.obj["project"]) if ctx.obj.get("project") else Path.cwd()

    async def _voice():
        orchestrator = JAAOrchestrator(project_root)
        await orchestrator.initialize()

        if not orchestrator.voice:
            console.print("[red]Voice pipeline not available. Check configuration.[/red]")
            return

        console.print("[bold cyan]Voice mode activated. Say 'Hey JAA' to start.[/bold cyan]")
        console.print("[dim]Press Ctrl+C to exit[/dim]\n")

        try:
            async for result in orchestrator.voice.start_listening():
                if result.is_final and result.text.strip():
                    console.print(f"[bold blue]You:[/bold blue] {result.text}")

                    with console.status("[bold cyan]Thinking...", spinner="dots"):
                        response = await orchestrator.process_text(result.text, voice_mode=True)
                    console.print(f"[bold green]J.A.A.:[/bold green] {response}")

                    if orchestrator.voice:
                        await orchestrator.voice.speak(response)

        except KeyboardInterrupt:
            console.print("\n[dim]Voice mode stopped[/dim]")

    asyncio.run(_voice())


@main.command()
@click.pass_context
def serve(ctx: click.Context) -> None:
    """Start MCP server for IDE integration."""
    from jaa.integrations.mcp.server import run_server

    project_root = Path(ctx.obj["project"]) if ctx.obj.get("project") else Path.cwd()
    console.print("[bold cyan]Starting J.A.A. MCP server...[/bold cyan]")
    console.print(f"[dim]Project root: {project_root} - connect from VS Code, Cursor, or Claude Code[/dim]\n")

    asyncio.run(run_server(project_root=project_root))


@main.command()
@click.option("--host", default="127.0.0.1", help="Host to bind")
@click.option("--port", default=8000, help="Port to bind")
@click.pass_context
def api(ctx: click.Context, host: str, port: int) -> None:
    """Start REST API server (GET /health, /v1/models; POST /v1/chat, /v1/code, /v1/memory/search)."""
    from jaa.integrations.api import serve_api

    project_root = Path(ctx.obj["project"]) if ctx.obj.get("project") else Path.cwd()
    console.print(f"[bold cyan]Starting J.A.A. API server on http://{host}:{port}[/bold cyan]")
    console.print("[dim]Endpoints: GET /health, GET /v1/models, POST /v1/chat, POST /v1/code, POST /v1/memory/search[/dim]")
    console.print("[dim]Press Ctrl+C to stop[/dim]\n")

    try:
        asyncio.run(serve_api(project_root, host, port))
    except KeyboardInterrupt:
        console.print("\n[dim]API server stopped[/dim]")


@main.command()
@click.pass_context
def config(ctx: click.Context) -> None:
    """Manage configuration."""
    settings = get_settings()

    console.print("[bold]J.A.A. Configuration:[/bold]\n")
    console.print(f"  Data directory: {settings.data_dir}")
    console.print(f"  Log level: {settings.log_level}")
    console.print(f"  Debug mode: {settings.debug}")

    console.print("\n[bold]LLM Settings:[/bold]")
    console.print(f"  Local provider: {settings.llm.local_provider}")
    console.print(f"  Ollama host: {settings.llm.effective_base_url}")
    console.print(f"  Local models: {settings.llm.local_models}")
    console.print(f"  OpenRouter: {'[green]configured[/green]' if settings.llm.openrouter_api_key else '[dim]not set (jaa key set openrouter)[/dim]'}")
    console.print(f"  Anthropic: {'[green]configured[/green]' if settings.llm.anthropic_api_key else '[dim]not set[/dim]'}")
    console.print(f"  OpenAI: {'[green]configured[/green]' if settings.llm.openai_api_key else '[dim]not set[/dim]'}")
    console.print(f"  Google: {'[green]configured[/green]' if settings.llm.google_api_key else '[dim]not set[/dim]'}")
    console.print(f"  OpenAI-compatible endpoint: {settings.llm.compatible_base_url or '[dim]not set (jaa key url ...)[/dim]'}")
    console.print(f"  Prefer local models: {settings.llm.prefer_local}")

    console.print("\n[bold]Skills:[/bold]")
    from jaa.skills import SkillManager
    skills = SkillManager().list_installed()
    console.print(f"  Skills dir: {settings.skills_dir}")
    console.print(f"  Installed skills: {len(skills)}")

    console.print("\n[bold]Voice Settings:[/bold]")
    console.print(f"  STT engine: {settings.voice.stt_engine}")
    console.print(f"  TTS engine: {settings.voice.tts_engine}")
    console.print(f"  Wake word: {settings.voice.wake_word}")

    console.print("\n[bold]Agent Settings:[/bold]")
    console.print(f"  Code agent: {settings.agent.code_enabled}")
    console.print(f"  Desktop agent: {settings.agent.desktop_enabled}")
    console.print(f"  System agent: {settings.agent.system_enabled}")

    console.print("\n[bold]Memory Settings:[/bold]")
    console.print(f"  Vector store: {settings.memory.vector_store}")
    console.print(f"  ChromaDB path: {settings.memory.chromadb_path}")


PROVIDER_KEYS: dict[str, str] = {
    "openrouter": "JAA_LLM_OPENROUTER_API_KEY",
    "anthropic": "JAA_LLM_ANTHROPIC_API_KEY",
    "openai": "JAA_LLM_OPENAI_API_KEY",
    "google": "JAA_LLM_GOOGLE_API_KEY",
}


@main.group()
def key() -> None:
    """Manage your own API keys for cloud providers (stored in ~/.jaa/.env).

    J.A.A. uses whatever key you provide here - nothing is hardcoded.
    """


@key.command("set")
@click.argument("provider")
@click.argument("value", required=False)
@click.pass_context
def key_set(ctx: click.Context, provider: str, value: str | None) -> None:
    """Set an API key for a provider.

    Providers: openrouter, anthropic, openai, google, compatible.
    For 'compatible' you also set the base URL via `jaa key url`.
    If VALUE is omitted you'll be prompted (hidden input).
    """
    from jaa.config.keys import write_user_env

    provider = provider.lower()
    if provider == "compatible":
        var = "JAA_LLM_COMPATIBLE_API_KEY"
    elif provider in PROVIDER_KEYS:
        var = PROVIDER_KEYS[provider]
    else:
        console.print(f"[red]Unknown provider '{provider}'. Choose: {', '.join(list(PROVIDER_KEYS) + ['compatible'])}[/red]")
        sys.exit(1)

    if not value:
        value = click.prompt(f"Enter your {provider} API key", hide_input=True, confirmation_prompt=True)
    if not value or not value.strip():
        console.print("[red]No key provided.[/red]")
        sys.exit(1)

    write_user_env({var: value.strip()})
    console.print(f"[green]✓ {provider} API key saved to ~/.jaa/.env[/green]")
    console.print("J.A.A. will use this key on next run (cloud models, with local models preferred first).")


@key.command("url")
@click.argument("url_value", required=False)
@click.pass_context
def key_url(ctx: click.Context, url_value: str | None) -> None:
    """Set the base URL for the 'compatible' (OpenAI-compatible) provider.

    Example: jaa key url https://api.groq.com/openai/v1
    """
    from jaa.config.keys import write_user_env

    if not url_value:
        url_value = click.prompt("Enter the OpenAI-compatible base URL")
    if not url_value.strip():
        console.print("[red]No URL provided.[/red]")
        sys.exit(1)
    write_user_env({"JAA_LLM_COMPATIBLE_BASE_URL": url_value.strip()})
    console.print(f"[green]✓ Compatible base URL set to {url_value.strip()}[/green]")


@key.command("list")
@click.pass_context
def key_list(ctx: click.Context) -> None:
    """Show which providers have keys configured (values masked)."""
    import os as _os

    from jaa.config.keys import mask_key, read_user_env
    from jaa.config.settings import get_settings

    stored = read_user_env()
    console.print("[bold]Configured API keys:[/bold]")
    console.print(f"  (stored in {Path.home() / '.jaa' / '.env'})\n")

    configured = 0
    for name, var in PROVIDER_KEYS.items():
        value = stored.get(var) or _os.environ.get(var)
        if value:
            console.print(f"  • [bold]{name}[/bold]: {mask_key(value)}")
            configured += 1
        else:
            console.print(f"  • {name}: [dim]not set[/dim]")

    compat_key = stored.get("JAA_LLM_COMPATIBLE_API_KEY") or _os.environ.get("JAA_LLM_COMPATIBLE_API_KEY")
    compat_url = stored.get("JAA_LLM_COMPATIBLE_BASE_URL") or _os.environ.get("JAA_LLM_COMPATIBLE_BASE_URL")
    if compat_key or compat_url:
        configured += 1
        console.print(f"  • [bold]compatible[/bold]: {mask_key(compat_key or '')} @ {compat_url or 'no URL set'}")
    else:
        console.print("  • compatible: [dim]not set[/dim]")

    llm = get_settings().llm
    console.print(f"\n  Local-first routing: {llm.prefer_local}")
    console.print("  Tip: set JAA_LLM_PREFER_LOCAL=false to prefer cloud models.")

    if not configured:
        console.print("\n[yellow]No keys set yet. Use `jaa key set openrouter <key>` (or anthropic/openai/google).[/yellow]")


@key.command("remove")
@click.argument("provider")
@click.pass_context
def key_remove(ctx: click.Context, provider: str) -> None:
    """Remove a provider's key from ~/.jaa/.env."""
    from jaa.config.keys import remove_user_env

    provider = provider.lower()
    if provider == "compatible":
        keys = ["JAA_LLM_COMPATIBLE_API_KEY", "JAA_LLM_COMPATIBLE_BASE_URL"]
    elif provider in PROVIDER_KEYS:
        keys = [PROVIDER_KEYS[provider]]
    else:
        console.print(f"[red]Unknown provider '{provider}'.[/red]")
        sys.exit(1)

    remove_user_env(keys)
    console.print(f"[green]✓ Removed {provider} key from ~/.jaa/.env[/green]")


@main.group()
def skill() -> None:
    """Manage globally-installed agent skills (search GitHub, install, list)."""


@skill.command("search")
@click.argument("query")
@click.option("--limit", default=8, show_default=True, help="Max results")
@click.pass_context
def skill_search(ctx: click.Context, query: str, limit: int) -> None:
    """Search GitHub for agent-skill repositories."""
    from jaa.skills import SkillManager

    manager = SkillManager()
    console.print(f"[bold cyan]Searching GitHub for '{query}' skills...[/bold cyan]\n")

    async def _search():
        results = await manager.search_github(query, limit=limit)
        if not results:
            console.print("[yellow]No results found.[/yellow]")
            return
        for r in results:
            stars = f" ⭐{r.stars}" if r.stars else ""
            console.print(f"[bold]{r.full_name}[/bold]{stars}")
            console.print(f"  {r.description or 'No description'}")
            console.print(f"  [dim]install: jaa skill install {r.full_name}[/dim]")
            console.print()

    asyncio.run(_search())


@skill.command("install")
@click.argument("repo")
@click.option("--branch", default=None, help="Branch to install (default: repo default)")
@click.pass_context
def skill_install(ctx: click.Context, repo: str, branch: str | None) -> None:
    """Install a GitHub repo (owner/name) of agent skills globally."""
    from jaa.skills import SkillManager

    manager = SkillManager()
    console.print(f"[bold cyan]Installing {repo}...[/bold cyan]")

    async def _install():
        try:
            with console.status("[cyan]Cloning...", spinner="dots"):
                dest = await manager.install(repo, branch=branch)
            skills = [s for s in manager.list_installed() if s.source_repo.replace("/", "__") in str(dest)]
            console.print(f"[green]✓ Installed to {dest}[/green]")
            if skills:
                console.print(f"\n[bold]Discovered {len(skills)} skill(s):[/bold]")
                for s in skills[:10]:
                    console.print(f"  - {s.name}: {s.description[:80]}")
            else:
                console.print("[yellow]No SKILL.md files found in this repo.[/yellow]")
        except Exception as e:
            console.print(f"[red]✗ Failed: {e}[/red]")
            sys.exit(1)

    asyncio.run(_install())


@skill.command("list")
@click.option("--json", "as_json", is_flag=True, help="Output as JSON")
@click.pass_context
def skill_list(ctx: click.Context, as_json: bool) -> None:
    """List globally-installed skills."""
    from jaa.skills import SkillManager

    manager = SkillManager()
    skills = manager.list_installed()
    if not skills:
        console.print("[yellow]No skills installed. Try: jaa skill search <topic>[/yellow]")
        return

    if as_json:
        import json as _json
        console.print(_json.dumps(
            [{"name": s.name, "description": s.description, "source": s.source_repo} for s in skills],
            indent=2,
        ))
        return

    console.print(f"[bold]{len(skills)} skill(s) installed in ~/.jaa/skills:[/bold]\n")
    for s in skills:
        src = f" [dim]({s.source_repo})[/dim]" if s.source_repo else ""
        console.print(f"  • [bold]{s.name}[/bold]{src}")
        console.print(f"      {s.description}")


@skill.command("remove")
@click.argument("repo")
@click.pass_context
def skill_remove(ctx: click.Context, repo: str) -> None:
    """Remove an installed skill repo (owner/name)."""
    from jaa.skills import SkillManager

    manager = SkillManager()
    if manager.remove(repo):
        console.print(f"[green]✓ Removed {repo}[/green]")
    else:
        console.print(f"[red]Not found: {repo}[/red]")
        sys.exit(1)


@main.command()
@click.argument("path", required=False)
@click.option("--force", is_flag=True, help="Re-index even unchanged files")
@click.pass_context
def index(ctx: click.Context, path: str | None, force: bool) -> None:
    """Index the project codebase for retrieval-augmented coding."""
    from jaa.memory import MemoryManager

    project_root = Path(path).resolve() if path else Path(ctx.obj.get("project") or Path.cwd()).resolve()
    if not project_root.exists():
        console.print(f"[red]Path does not exist: {project_root}[/red]")
        sys.exit(1)

    console.print(f"[bold cyan]Indexing codebase[/bold cyan] -> {project_root}")
    console.print("[dim]This may take a while on large projects (first run only).[/dim]\n")

    async def _index():
        memory = MemoryManager(project_root)
        await memory.initialize()
        with console.status("[cyan]Indexing files...", spinner="dots") as status:
            stats = await memory.index_codebase(force=force)
        console.print(f"[green]Done:[/green] {stats['indexed']} indexed, {stats['skipped']} skipped, {stats['errors']} errors")

    asyncio.run(_index())


@main.command()
@click.argument("path", required=False)
@click.pass_context
def analyze(ctx: click.Context, path: str | None) -> None:
    """Summarize a project tree and highlight the most relevant files."""
    from jaa.utils import find_project_root, summarize_project

    project_root = Path(path).resolve() if path else Path(ctx.obj.get("project") or Path.cwd()).resolve()
    if not project_root.exists():
        console.print(f"[red]Path does not exist: {project_root}[/red]")
        sys.exit(1)

    summary = summarize_project(project_root)
    console.print(f"[bold cyan]Project analysis[/bold cyan] -> {project_root}")
    console.print(summary)

    python_files = sorted([p for p in project_root.rglob("*.py") if p.is_file()])[:10]
    if python_files:
        console.print("\n[bold]Key Python files:[/bold]")
        for file_path in python_files:
            console.print(f"  - {file_path.relative_to(project_root)}")


@main.command()
@click.option("--pull/--no-pull", default=True, help="Pull missing recommended models")
@click.pass_context
def setup(ctx: click.Context, pull: bool) -> None:
    """Check Ollama and set up the recommended local models."""
    console.print("[bold]J.A.A. setup — local models[/bold]\n")

    # 1. Check Ollama is installed and reachable
    if not _check_ollama():
        console.print("[red]✗ Ollama is not installed or not in PATH.[/red]")
        console.print("  Install it from https://ollama.com and start the service, then re-run `jaa setup`.")
        sys.exit(1)
    console.print("[green]✓ Ollama found[/green]")

    # 2. List installed models
    installed = _ollama_models()
    if installed:
        console.print("[green]✓ Installed models:[/green]")
        for m in installed:
            console.print(f"    {m}")
    else:
        console.print("[yellow]No models installed yet.[/yellow]")

    # 3. Determine what's missing from the recommended set
    settings = get_settings().llm
    recommended = {
        "coder": settings.local_models.get("coder", "qwen2.5-coder:7b"),
        "general": settings.local_models.get("general", "qwen3:8b"),
        "reasoning": settings.local_models.get("reasoning", "qwen3:4b"),
        "embed": settings.local_models.get("embed", "nomic-embed-text:latest"),
    }

    missing = {role: model for role, model in recommended.items() if model not in installed}
    if not missing:
        console.print("\n[bold green]All recommended models are installed. J.A.A. is ready![/bold green]")
        console.print("\nRun `jaa chat` to start coding.")
        return

    console.print("\n[bold]Recommended models not found:[/bold]")
    for role, model in missing.items():
        console.print(f"    {role}: {model}")

    if not pull:
        console.print("\nRe-run with `--pull` to download them, or set JAA_LLM_LOCAL_MODELS to your preferred models.")
        return

    # 4. Pull missing models
    for role, model in missing.items():
        console.print(f"\n[cyan]Pulling {model} ({role})...[/cyan]")
        ok, msg = _ollama_pull(model)
        if ok:
            console.print(f"[green]✓ Installed {model}[/green]")
        else:
            console.print(f"[red]✗ Failed to pull {model}: {msg}[/red]")

    console.print("\n[bold green]Setup complete. Run `jaa chat` to start coding![/bold green]")
    console.print("\nOptional: add your own cloud API keys with `jaa key set <provider> <key>`")
    console.print("  (providers: openrouter, anthropic, openai, google, compatible)")


@main.command()
@click.pass_context
def doctor(ctx: click.Context) -> None:
    """Run health checks."""
    console.print("[bold]Running J.A.A. health checks...[/bold]\n")

    checks = [
        ("Python version", lambda: sys.version_info >= (3, 10)),
        ("Ollama available", lambda: _check_ollama()),
        ("Voice dependencies", lambda: _check_voice()),
        ("Desktop automation", lambda: _check_desktop()),
        ("Memory (ChromaDB)", lambda: _check_chromadb()),
    ]

    all_passed = True
    for name, check in checks:
        try:
            result = check()
            status = "[green]✓ PASS[/green]" if result else "[red]✗ FAIL[/red]"
            if not result:
                all_passed = False
        except Exception as e:
            status = f"[red]✗ ERROR: {e}[/red]"
            all_passed = False
        console.print(f"  {name}: {status}")

    console.print()
    if all_passed:
        console.print("[bold green]All checks passed![/bold green]")
    else:
        console.print("[bold red]Some checks failed. See above for details.[/bold red]")
        sys.exit(1)


def _check_ollama() -> bool:
    import subprocess
    try:
        result = subprocess.run(["ollama", "list"], capture_output=True, timeout=10)
        return result.returncode == 0
    except Exception:
        return False


def _ollama_models() -> list[str]:
    """Return installed Ollama model names (without tags when latest)."""
    import subprocess
    try:
        result = subprocess.run(["ollama", "list"], capture_output=True, text=True, timeout=10)
        models = []
        for line in result.stdout.strip().splitlines()[1:]:
            if line.strip():
                name = line.split()[0].strip()
                # Normalize: `qwen3-coder:latest` matches `qwen3-coder` and vice versa
                models.append(name)
                if name.endswith(":latest"):
                    models.append(name[: -len(":latest")])
        return models
    except Exception:
        return []


def _ollama_pull(model: str) -> tuple[bool, str]:
    """Pull an Ollama model."""
    import subprocess
    try:
        result = subprocess.run(
            ["ollama", "pull", model],
            capture_output=True,
            text=True,
            timeout=1800,
        )
        if result.returncode == 0:
            return True, "ok"
        return False, result.stderr.strip() or result.stdout.strip()
    except Exception as e:
        return False, str(e)


def _check_voice() -> bool:
    try:
        import faster_whisper
        import piper_tts
        return True
    except ImportError:
        return False


def _check_desktop() -> bool:
    try:
        import pyautogui
        import pynput
        if is_windows():
            import win32gui
        return True
    except ImportError:
        return False


def _check_chromadb() -> bool:
    try:
        import chromadb
        return True
    except ImportError:
        return False


def is_windows() -> bool:
    import platform
    return platform.system().lower() == "windows"


if __name__ == "__main__":
    main()