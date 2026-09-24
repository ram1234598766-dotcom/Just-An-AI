"""
J.A.A. Voice mode entry point.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel

from jaa.config.settings import get_settings
from jaa.orchestrator import JAAOrchestrator

console = Console()


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(console=console, rich_tracebacks=True)],
    )


@click.command()
@click.option("--project-root", "-p", type=click.Path(exists=True, path_type=Path), help="Project root directory")
@click.option("--debug", "-d", is_flag=True, help="Enable debug mode")
@click.option("--continuous/--once", default=True, help="Continuous listening mode")
def main(project_root: Path | None, debug: bool, continuous: bool) -> None:
    """Run J.A.A. in voice mode."""
    if debug:
        setup_logging("DEBUG")
    else:
        setup_logging("INFO")

    if project_root is None:
        project_root = Path.cwd()

    asyncio.run(_run_voice(project_root, continuous))


async def _run_voice(project_root: Path, continuous: bool) -> None:
    orchestrator = JAAOrchestrator(project_root)

    try:
        await orchestrator.initialize()

        if not orchestrator.voice:
            console.print("[red]Voice pipeline not available. Check microphone and dependencies.[/red]")
            return

        console.print(Panel(
            "🎤 [bold]Voice Mode Active[/bold]\n"
            "Say 'Hey JAA' to activate\n"
            "Press Ctrl+C to exit",
            title="J.A.A. Voice",
            border_style="green"
        ))

        if continuous:
            await orchestrator.run_voice_mode()
        else:
            # Single interaction
            console.print("[dim]Listening for wake word...[/dim]")
            async for transcription in orchestrator.voice.start_listening():
                if transcription.text.strip():
                    console.print(f"👤 [bold]You:[/bold] {transcription.text}")
                    response = await orchestrator.process_text(transcription.text, voice_mode=True)
                    console.print(f"🤖 [bold]J.A.A.:[/bold] {response}")
                    await orchestrator.voice.speak(response)
                break

    except KeyboardInterrupt:
        console.print("\n[yellow]Voice mode stopped[/yellow]")
    except Exception as e:
        console.print(f"[red]Voice error: {e}[/red]")
        raise
    finally:
        await orchestrator.shutdown()


if __name__ == "__main__":
    main()