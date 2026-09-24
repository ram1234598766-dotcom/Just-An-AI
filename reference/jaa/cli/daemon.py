"""
J.A.A. Daemon entry point.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.logging import RichHandler

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
def main(project_root: Path | None, debug: bool) -> None:
    """Run J.A.A. as background daemon."""
    if debug:
        setup_logging("DEBUG")
    else:
        setup_logging("INFO")

    if project_root is None:
        project_root = Path.cwd()

    asyncio.run(_run_daemon(project_root))


async def _run_daemon(project_root: Path) -> None:
    orchestrator = JAAOrchestrator(project_root)

    try:
        await orchestrator.initialize()
        console.print("[green]🤖 J.A.A. daemon started[/green]")
        console.print(f"[dim]Project root: {project_root}[/dim]")

        # Keep running
        while True:
            await asyncio.sleep(3600)

    except KeyboardInterrupt:
        console.print("\n[yellow]Daemon stopped[/yellow]")
    except Exception as e:
        console.print(f"[red]Daemon error: {e}[/red]")
        raise
    finally:
        await orchestrator.shutdown()


if __name__ == "__main__":
    main()