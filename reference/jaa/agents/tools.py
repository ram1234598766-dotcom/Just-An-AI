"""
Tool agent and tool definitions for J.A.A.

Provides agentic capabilities including web search, shell execution,
file operations, and system information retrieval.
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import socket
import subprocess
import time
from pathlib import Path
from typing import Any

from jaa.config.settings import get_settings
from jaa.llm import LLMOrchestrator, LLMRequest, LLMResponse, ModelType
from jaa.utils import run_command_sync, trim_history

logger = logging.getLogger(__name__)


def _max_tool_result_chars() -> int:
    """Cap on tool output fed back to the model (configurable via JAA_LLM_MAX_TOOL_RESULT_CHARS)."""
    try:
        return get_settings().llm.max_tool_result_chars or 4000
    except Exception:
        return 4000


MAX_TOOL_RESULT_CHARS = _max_tool_result_chars()


def _safe_resolve(path: str, project_root: Path) -> Path:
    full = (project_root / path).resolve()
    if not full.is_relative_to(project_root.resolve()):
        raise PermissionError(f"Path outside project root: {path}")
    return full


async def tool_web_search(query: str, max_results: int = 5) -> str:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        return "Web search is not available. Install duckduckgo-search to enable it."
    try:
        results = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results):
                results.append(f"{r.get('title', '')}\n{r.get('href', '')}\n{r.get('body', '')}")
        out = "\n\n".join(results) if results else "No results found."
        return out[:MAX_TOOL_RESULT_CHARS]
    except Exception as e:
        return f"Web search failed: {e}"


async def tool_shell_execute(command: str, cwd: str | None = None, timeout: float = 60.0) -> str:
    settings = get_settings().security
    cmd_parts = command.strip().split()
    base_cmd = cmd_parts[0].lower() if cmd_parts else ""
    if base_cmd in settings.blocked_commands:
        return f"Blocked command: {base_cmd}"
    if settings.allow_shell is False and base_cmd not in settings.allowed_commands:
        return (
            f"Command '{base_cmd}' is not in the allowed list. "
            f"Add it to JAA_SECURITY_ALLOWED_COMMANDS or set JAA_SECURITY_ALLOW_SHELL=true to allow shell commands."
        )
    try:
        rc, out, err = await run_command_sync(command, cwd=cwd, timeout=timeout)
        out = out[:MAX_TOOL_RESULT_CHARS]
        err = err[:MAX_TOOL_RESULT_CHARS]
        return f"Exit code: {rc}\nStdout:\n{out}\nStderr:\n{err}"
    except Exception as e:
        return f"Command failed: {e}"


async def tool_read_file(path: str, project_root: Path) -> str:
    try:
        full = _safe_resolve(path, project_root)
        if not full.exists():
            return f"File not found: {path}"
        if full.stat().st_size > 10 * 1024 * 1024:
            return "File too large to read."
        return full.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return f"Failed to read file: {e}"


async def tool_write_file(path: str, content: str, project_root: Path) -> str:
    try:
        full = _safe_resolve(path, project_root)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        return f"Written to {path}"
    except Exception as e:
        return f"Failed to write file: {e}"


async def tool_list_directory(path: str, project_root: Path) -> str:
    try:
        full = _safe_resolve(path, project_root)
        if not full.exists() or not full.is_dir():
            return f"Directory not found: {path}"
        entries = []
        for p in sorted(full.iterdir()):
            entries.append(f"{'[DIR] ' if p.is_dir() else '[FILE]'} {p.name}")
        return "\n".join(entries[:200])
    except Exception as e:
        return f"Failed to list directory: {e}"


async def tool_get_system_info() -> str:
    try:
        import psutil
        cpu = psutil.cpu_percent(interval=0.5)
        mem = psutil.virtual_memory()
        disk = psutil.disk_usage(Path.home().anchor or "/")
        return (
            f"System: {platform.system()} {platform.version()}\n"
            f"Hostname: {socket.gethostname()}\n"
            f"CPU: {cpu}% ({psutil.cpu_count()} cores)\n"
            f"Memory: {mem.percent}% used ({mem.used/1e9:.1f}/{mem.total/1e9:.1f} GB)\n"
            f"Disk: {disk.percent}% used ({disk.used/1e9:.1f}/{disk.total/1e9:.1f} GB)"
        )
    except Exception as e:
        return f"Failed to get system info: {e}"


TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information, news, or facts.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "max_results": {"type": "integer", "description": "Max results", "default": 5},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "shell_execute",
            "description": "Run an allowed shell command in the project directory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Command to run"},
                    "cwd": {"type": "string", "description": "Working directory"},
                    "timeout": {"type": "number", "description": "Timeout seconds", "default": 60},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a file inside the current project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to file"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file inside the current project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to file"},
                    "content": {"type": "string", "description": "File content"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and directories inside the current project.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative directory path", "default": "."},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_system_info",
            "description": "Get current system status (CPU, memory, disk).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

_TOOL_HANDLERS = {
    "web_search": tool_web_search,
    "shell_execute": tool_shell_execute,
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "list_directory": tool_list_directory,
    "get_system_info": tool_get_system_info,
}


async def execute_tool_call(tool_call: dict, project_root: Path) -> str:
    if "function" in tool_call:
        name = tool_call.get("function", {}).get("name")
        args = tool_call.get("function", {}).get("arguments", {})
    else:
        name = tool_call.get("name")
        args = tool_call.get("args", {})

    if isinstance(args, str):
        import json
        try:
            args = json.loads(args)
        except json.JSONDecodeError:
            return f"Invalid tool arguments: {args}"

    handler = _TOOL_HANDLERS.get(name)
    if not handler:
        return f"Unknown tool: {name}"

    try:
        if name in {"read_file", "write_file", "list_directory"}:
            return await handler(**(args | {"project_root": project_root}))
        return await handler(**args)
    except Exception as e:
        return f"Tool {name} failed: {e}"


class ToolAgent:
    """Agent that uses LLM tool calling to perform multi-step tasks."""

    def __init__(self, llm: LLMOrchestrator, project_root: Path):
        self.llm = llm
        self.project_root = project_root
        self.max_iterations = 8

    _SYSTEM_PROMPT = (
        "You are J.A.A., an expert agentic AI assistant. "
        "You excel at breaking complex requests into concrete, executable steps "
        "and using tools to gather facts before answering.\n"
        "Strengths:\n"
        "1) Programming — Python, JavaScript/TypeScript, Rust, Go, C/C++, Java, SQL, shell, "
        "and software engineering best practices. Write production-quality, well-structured code "
        "and verify it before claiming it works.\n"
        "2) Problem solving — decompose tasks, use tools to inspect the real state of things "
        "(files, commands, web), and iterate based on results.\n"
        "3) Knowledge & reasoning — general knowledge, math/logic (show clear step-by-step reasoning), "
        "and law (cite relevant sections/articles when possible).\n"
        "Rules:\n"
        "- Use tools to find out the truth; never fabricate file contents, command output, or web results.\n"
        "- Keep answers concise, actionable, and confident.\n"
        "- For file operations, use paths relative to the project root.\n"
        "- Stop as soon as the task is complete; don't over-engineer."
    )

    def _build_messages(self, task: str) -> list[dict]:
        """Build the initial message list (system prompt + installed skills)."""
        system = self._SYSTEM_PROMPT
        try:
            from jaa.skills import SkillManager
            skills = SkillManager().build_context(query=task)
            if skills:
                system += "\n\n" + skills
        except Exception:
            pass
        return [
            {"role": "system", "content": system},
            {"role": "user", "content": task},
        ]

    async def run(self, task: str) -> str:
        messages = self._build_messages(task)
        chunks = []
        async for chunk in self._run_tool_loop(messages, stream=False):
            chunks.append(chunk)
        return "".join(chunks)

    async def stream(self, task: str):
        """Stream response for a task. Yields text chunks."""
        messages = self._build_messages(task)
        async for chunk in self._run_tool_loop(messages, stream=True):
            yield chunk

    async def _run_tool_loop(self, messages: list[dict], stream: bool):
        """Iterate model <-> tool calls until the model answers without tools."""
        budget = get_settings().llm.max_context_tokens - get_settings().llm.context_window_reserve
        for _ in range(self.max_iterations):
            # Keep long sessions cheap: drop oldest tool history when over budget
            messages = trim_history(messages, token_budget=max(2000, budget))

            request = LLMRequest(
                messages=messages,
                model_type=ModelType.GENERAL,
                temperature=0.3,
                tools=TOOL_SCHEMAS,
            )
            response = await self.llm.generate(request)
            tool_calls = getattr(response, "tool_calls", None) or []

            if not tool_calls:
                messages.append({"role": "assistant", "content": response.content})
                yield response.content
                return

            messages.append({"role": "assistant", "content": response.content, "tool_calls": tool_calls})
            for tc in tool_calls:
                result = await execute_tool_call(tc, self.project_root)
                messages.append({"role": "tool", "tool_call_id": tc.get("id"), "content": result})

        # Ran out of iterations: ask for a final answer without tools
        final_request = LLMRequest(
            messages=messages,
            model_type=ModelType.GENERAL,
            temperature=0.3,
        )
        final_response = await self.llm.generate(final_request)
        if stream:
            async for chunk in self.llm.generate_stream(final_request):
                yield chunk.content
        else:
            yield final_response.content
