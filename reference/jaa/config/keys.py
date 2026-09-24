"""
User API-key management.

Keys live in the user's own `~/.jaa/.env` file (the same file Settings already
reads), so whatever the user provides is exactly what J.A.A. uses - nothing is
hardcoded or stored elsewhere.
"""

from __future__ import annotations

import logging
import os
import stat
from pathlib import Path
from typing import Iterable

logger = logging.getLogger(__name__)


def user_env_file() -> Path:
    """Path to the user's J.A.A. env file (~/.jaa/.env)."""
    return Path.home() / ".jaa" / ".env"


def read_user_env() -> dict[str, str]:
    """Read key=value pairs from ~/.jaa/.env (best-effort parse)."""
    path = user_env_file()
    result: dict[str, str] = {}
    if not path.exists():
        return result
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            result[key.strip()] = value.strip().strip("\"'")
    except Exception as e:
        logger.warning(f"Failed to read {path}: {e}")
    return result


def write_user_env(entries: dict[str, str]) -> Path:
    """Write/replace key=value entries in ~/.jaa/.env, preserving other lines.

    Returns the file path written.
    """
    path = user_env_file()
    path.parent.mkdir(parents=True, exist_ok=True)

    existing = {}
    if path.exists():
        try:
            existing = read_user_env()
        except Exception:
            existing = {}

    merged = {**existing, **entries}

    lines = []
    seen = set()
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                if "=" in line and not line.strip().startswith("#"):
                    key = line.split("=", 1)[0].strip()
                    if key in merged:
                        lines.append(f"{key}={merged[key]}")
                        seen.add(key)
                        continue
                lines.append(line)
        except Exception:
            lines = []

    for key, value in merged.items():
        if key not in seen:
            lines.append(f"{key}={value}")

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Lock down permissions on Unix so keys aren't world-readable.
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass

    logger.info(f"Updated {path}")
    return path


def remove_user_env(keys: Iterable[str]) -> Path:
    """Remove the given keys from ~/.jaa/.env, preserving other lines."""
    path = user_env_file()
    if not path.exists():
        return path

    remove = set(keys)
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.strip().startswith("#"):
            key = line.split("=", 1)[0].strip()
            if key in remove:
                continue
        lines.append(line)

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except Exception:
        pass
    return path


def mask_key(value: str) -> str:
    """Mask a secret for display: sk-or-...AbCd"""
    if not value:
        return ""
    if len(value) <= 12:
        return "*" * len(value)
    return f"{value[:8]}...{value[-4:]}"
