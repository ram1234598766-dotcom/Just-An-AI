"""
Utility functions for J.A.A.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import platform
import shutil
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

logger = logging.getLogger(__name__)


def get_platform() -> str:
    """Get normalized platform name."""
    system = platform.system().lower()
    if system == "darwin":
        return "macos"
    return system


def is_windows() -> bool:
    return get_platform() == "windows"


def is_macos() -> bool:
    return get_platform() == "macos"


def is_linux() -> bool:
    return get_platform() == "linux"


def get_shell() -> list[str]:
    """Get default shell for platform."""
    if is_windows():
        return ["cmd", "/c"]
    return ["/bin/bash", "-c"]


async def run_command(
    cmd: str | list[str],
    cwd: Path | str | None = None,
    env: dict | None = None,
    timeout: float = 60.0,
) -> tuple[int, str, str]:
    """Run command asynchronously."""
    if isinstance(cmd, str):
        import shlex
        cmd = shlex.split(cmd)

    proc_env = os.environ.copy()
    if env:
        proc_env.update(env)

    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(cwd) if cwd else None,
            env=proc_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout,
        )

        return process.returncode, stdout.decode(errors="replace"), stderr.decode(errors="replace")

    except asyncio.TimeoutError:
        return -1, "", f"Command timed out after {timeout}s"
    except Exception as e:
        return -1, "", str(e)


async def run_command_sync(
    cmd: str | list[str],
    cwd: Path | str | None = None,
    env: dict | None = None,
    timeout: float = 60.0,
) -> tuple[int, str, str]:
    """Run command synchronously in thread pool."""
    if isinstance(cmd, str):
        import shlex
        cmd = shlex.split(cmd)

    def _run():
        proc_env = os.environ.copy()
        if env:
            proc_env.update(env)

        result = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=proc_env,
            capture_output=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout.decode(errors="replace"), result.stderr.decode(errors="replace")

    return await asyncio.to_thread(_run)


def hash_content(content: str, length: int = 16) -> str:
    """Create short hash of content."""
    return hashlib.sha256(content.encode()).hexdigest()[:length]


def hash_file(path: Path) -> str:
    """Hash file content."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ensure_dir(path: Path) -> Path:
    """Ensure directory exists."""
    path.mkdir(parents=True, exist_ok=True)
    return path


def find_project_root(start: Path | None = None) -> Path:
    """Find project root by looking for markers."""
    markers = [".git", "pyproject.toml", "package.json", "Cargo.toml", "go.mod", "pom.xml"]
    current = (start or Path.cwd()).resolve()

    while current != current.parent:
        for marker in markers:
            if (current / marker).exists():
                return current
        current = current.parent

    return Path.cwd()


def summarize_project(project_root: Path | str | None = None) -> str:
    """Generate a concise, high-signal summary of a project tree."""
    root = Path(project_root or find_project_root()).resolve()
    excluded_dirs = {".git", ".venv", "__pycache__", "node_modules", ".mypy_cache", ".pytest_cache"}

    files = [
        path for path in root.rglob("*")
        if path.is_file() and not any(part in excluded_dirs for part in path.parts)
    ]
    python_files = [path for path in files if path.suffix == ".py"]
    text_files = [path for path in files if path.suffix.lower() in {".md", ".txt", ".rst", ".json", ".yaml", ".yml", ".toml"}]

    top_level = sorted([path.name for path in root.iterdir() if path.is_dir() and path.name not in excluded_dirs])
    largest_files = sorted(files, key=lambda p: p.stat().st_size, reverse=True)[:5]
    largest_summary = ", ".join(f"{path.name} ({format_bytes(path.stat().st_size)})" for path in largest_files)

    return (
        f"Project summary for {root.name}: {len(python_files)} Python files, {len(text_files)} text/config files, "
        f"{len(files)} total files across {len(top_level)} top-level directories. "
        f"Largest files: {largest_summary}"
    )


def format_bytes(size: int) -> str:
    """Format bytes as human readable."""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} PB"


def format_duration(seconds: float) -> str:
    """Format duration as human readable."""
    if seconds < 60:
        return f"{seconds:.1f}s"
    elif seconds < 3600:
        return f"{seconds/60:.1f}m"
    elif seconds < 86400:
        return f"{seconds/3600:.1f}h"
    return f"{seconds/86400:.1f}d"


async def async_sleep(seconds: float) -> None:
    """Async sleep."""
    await asyncio.sleep(seconds)


@asynccontextmanager
async def timer(name: str) -> AsyncGenerator[None, None]:
    """Context manager for timing operations."""
    start = time.time()
    logger.debug(f"Starting: {name}")
    try:
        yield
    finally:
        elapsed = time.time() - start
        logger.debug(f"Completed: {name} in {elapsed:.3f}s")


class AsyncCache:
    """Simple async cache with TTL."""

    def __init__(self, ttl: float = 60.0):
        self.ttl = ttl
        self._cache: dict[str, tuple[Any, float]] = {}

    async def get(self, key: str) -> Any | None:
        if key in self._cache:
            value, timestamp = self._cache[key]
            if time.time() - timestamp < self.ttl:
                return value
            del self._cache[key]
        return None

    async def set(self, key: str, value: Any) -> None:
        self._cache[key] = (value, time.time())

    async def delete(self, key: str) -> None:
        self._cache.pop(key, None)

    async def clear(self) -> None:
        self._cache.clear()


class RateLimiter:
    """Async rate limiter."""

    def __init__(self, max_calls: int, period: float):
        self.max_calls = max_calls
        self.period = period
        self.calls: list[float] = []
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.time()
            # Remove old calls
            self.calls = [t for t in self.calls if now - t < self.period]

            if len(self.calls) >= self.max_calls:
                # Wait until oldest call expires
                wait_time = self.calls[0] + self.period - now
                if wait_time > 0:
                    await asyncio.sleep(wait_time)

            self.calls.append(time.time())


def truncate(text: str, max_length: int = 100, suffix: str = "...") -> str:
    """Truncate text to a compact, readable prefix plus suffix."""
    if len(text) <= max_length:
        return text
    if max_length <= len(suffix):
        return suffix[:max_length]
    return text[:max_length] + suffix


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars per token)."""
    return max(1, len(text) // 4)


def trim_history(messages: list[dict], token_budget: int = 20000, reserve_latest: int = 4) -> list[dict]:
    """Drop oldest messages until the list fits the token budget.

    The system prompt (first message) and the most recent messages are always
    kept. Used by tool loops so long sessions don't blow up the context window.
    """
    if not messages:
        return messages

    total = sum(estimate_tokens(str(m.get("content", ""))) for m in messages)
    if total <= token_budget:
        return messages

    # Always keep system (first) and the newest few messages
    keep_system = messages[:1] if messages[0].get("role") == "system" else []
    tail = messages[max(1, len(messages) - reserve_latest):]
    middle = messages[len(keep_system):len(messages) - reserve_latest]

    # Drop oldest messages from the middle, oldest first, until under budget
    for m in list(middle):
        if total <= token_budget:
            break
        total -= estimate_tokens(str(m.get("content", "")))
        middle.remove(m)

    return keep_system + middle + tail


def sanitize_filename(name: str) -> str:
    """Sanitize string for use as filename."""
    invalid = '<>:"/\\|?*'
    for char in invalid:
        name = name.replace(char, "_")
    return name.strip()


def get_free_port() -> int:
    """Get a free port."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def is_port_in_use(port: int, host: str = "127.0.0.1") -> bool:
    """Check if port is in use."""
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


def copy_file_safe(src: Path, dst: Path) -> bool:
    """Copy file with error handling."""
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return True
    except Exception as e:
        logger.error(f"Failed to copy {src} to {dst}: {e}")
        return False


def move_file_safe(src: Path, dst: Path) -> bool:
    """Move file with error handling."""
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        return True
    except Exception as e:
        logger.error(f"Failed to move {src} to {dst}: {e}")
        return False


def delete_path_safe(path: Path) -> bool:
    """Delete file or directory safely."""
    try:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
        return True
    except Exception as e:
        logger.error(f"Failed to delete {path}: {e}")
        return False


def setup_logging(level: str = "INFO", log_file: Path | None = None) -> None:
    """Setup structured logging."""
    import structlog
    import warnings

    os.environ.setdefault("TQDM_DISABLE", "1")
    warnings.filterwarnings("ignore", category=DeprecationWarning, module="langchain")
    warnings.filterwarnings("ignore", message=".*Pydantic V1 functionality.*")
    warnings.filterwarnings("ignore", message=".*LangChainPendingDeprecationWarning.*")
    warnings.filterwarnings("ignore", message=".*The default value of `allowed_objects`.*")

    log_level = getattr(logging, level.upper(), logging.INFO)

    handlers = [logging.StreamHandler(sys.stdout)]
    if log_file:
        ensure_dir(log_file.parent)
        handlers.append(logging.FileHandler(log_file))

    logging.basicConfig(
        level=log_level,
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=handlers,
    )

    structlog.configure(
        processors=[
            structlog.stdlib.filter_by_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.UnicodeDecoder(),
            structlog.processors.JSONRenderer(),
        ],
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    for noisy in ("httpx", "httpcore", "tqdm", "sentence_transformers", "huggingface_hub", "transformers", "ollama"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """Get logger instance."""
    return logging.getLogger(name)


# Decorators
def retry(
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: tuple = (Exception,),
):
    """Retry decorator for async functions."""
    def decorator(func):
        async def wrapper(*args, **kwargs):
            last_exception = None
            current_delay = delay

            for attempt in range(max_attempts):
                try:
                    return await func(*args, **kwargs)
                except exceptions as e:
                    last_exception = e
                    if attempt < max_attempts - 1:
                        logger.warning(f"Attempt {attempt + 1} failed: {e}. Retrying in {current_delay}s...")
                        await asyncio.sleep(current_delay)
                        current_delay *= backoff

            raise last_exception

        return wrapper
    return decorator


def timeout(seconds: float):
    """Timeout decorator for async functions."""
    def decorator(func):
        async def wrapper(*args, **kwargs):
            return await asyncio.wait_for(func(*args, **kwargs), timeout=seconds)
        return wrapper
    return decorator