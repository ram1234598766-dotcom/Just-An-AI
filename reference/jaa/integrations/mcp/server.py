"""
MCP (Model Context Protocol) Server for J.A.A.

Exposes J.A.A. capabilities as MCP tools for IDE integration
(VS Code, Cursor, Claude Code, etc.).
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    Tool,
    TextContent,
    CallToolResult,
)

from jaa.config.settings import get_settings
from jaa.core.orchestrator import JAAOrchestrator

logger = logging.getLogger(__name__)

# Global orchestrator instance
_orchestrator: JAAOrchestrator | None = None


def get_orchestrator() -> JAAOrchestrator:
    """Get or create global orchestrator."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = JAAOrchestrator(Path.cwd())
    return _orchestrator


async def initialize_orchestrator() -> None:
    """Initialize the global orchestrator."""
    global _orchestrator
    if _orchestrator is None:
        _orchestrator = JAAOrchestrator(Path.cwd())
        await _orchestrator.initialize()


# Create MCP server
server = Server("jaa")


@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available MCP tools."""
    return [
        Tool(
            name="jaa_chat",
            description="Send a message to J.A.A. and get a response",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Message to send"},
                    "voice_mode": {"type": "boolean", "default": False},
                },
                "required": ["message"],
            },
        ),
        Tool(
            name="jaa_code",
            description="Get code assistance - generate, refactor, debug, explain, or test code",
            inputSchema={
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "Code task description"},
                    "file": {"type": "string", "description": "Optional file path to work on"},
                    "language": {"type": "string", "description": "Programming language"},
                    "action": {"type": "string", "enum": ["generate", "refactor", "debug", "explain", "test", "document"]},
                },
                "required": ["task"],
            },
        ),
        Tool(
            name="jaa_desktop",
            description="Control desktop - open apps, manage windows, type, click, screenshot",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "open", "close", "focus", "arrange", "type", "click",
                            "screenshot", "shortcut", "switch"
                        ],
                    },
                    "target": {"type": "string", "description": "App name, window title, or coordinates"},
                    "params": {"type": "object", "description": "Additional parameters"},
                },
                "required": ["action"],
            },
        ),
        Tool(
            name="jaa_file",
            description="File operations - read, write, search, organize",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["read", "write", "list", "search", "organize", "delete", "move", "copy"],
                    },
                    "path": {"type": "string", "description": "File or directory path"},
                    "content": {"type": "string", "description": "Content for write operations"},
                    "pattern": {"type": "string", "description": "Search pattern"},
                },
                "required": ["action"],
            },
        ),
        Tool(
            name="jaa_system",
            description="System information and control - processes, ports, network, services",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["status", "processes", "ports", "network", "service"],
                    },
                    "target": {"type": "string", "description": "Process name, port, service name"},
                    "params": {"type": "object", "description": "Additional parameters"},
                },
                "required": ["action"],
            },
        ),
        Tool(
            name="jaa_memory",
            description="Access J.A.A. memory - search, store facts, get preferences",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["search", "store_fact", "get_preference", "set_preference", "stats"],
                    },
                    "query": {"type": "string", "description": "Search query"},
                    "fact": {"type": "string", "description": "Fact to store"},
                    "category": {"type": "string", "description": "Fact category"},
                    "key": {"type": "string", "description": "Preference key"},
                    "value": {"type": "string", "description": "Preference value"},
                },
                "required": ["action"],
            },
        ),
        Tool(
            name="jaa_index",
            description="Index or search codebase",
            inputSchema={
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["index", "search", "stats"]},
                    "query": {"type": "string", "description": "Search query"},
                    "force": {"type": "boolean", "default": False},
                },
                "required": ["action"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
    """Handle tool calls."""
    try:
        await initialize_orchestrator()
        orchestrator = get_orchestrator()

        if name == "jaa_chat":
            result = await orchestrator.process_text(
                arguments["message"],
                voice_mode=arguments.get("voice_mode", False),
            )
            return CallToolResult(content=[TextContent(type="text", text=result)])

        elif name == "jaa_code":
            from jaa.agents.code_agent import CodeContext

            task = arguments["task"]
            file_path = arguments.get("file")
            language = arguments.get("language", "python")
            action = arguments.get("action", "generate")

            # Build context-aware prompt
            prompt = f"{action.capitalize()} {language} code: {task}"
            if file_path:
                prompt += f" in {file_path}"

            context = CodeContext(
                project_root=orchestrator.project_root,
                current_file=Path(file_path) if file_path else None,
                language=language,
            )
            result = await orchestrator.code_agent.execute(prompt, context)
            return CallToolResult(content=[TextContent(type="text", text=result)])

        elif name == "jaa_desktop":
            action = arguments["action"]
            target = arguments.get("target", "")
            params = arguments.get("params", {})

            result = await _handle_desktop_action(orchestrator.desktop_agent, action, target, params)
            return CallToolResult(content=[TextContent(type="text", text=result)])

        elif name == "jaa_file":
            action = arguments["action"]
            path = arguments.get("path", "")
            content = arguments.get("content")
            pattern = arguments.get("pattern", "*")

            result = await _handle_file_action(orchestrator, action, path, content, pattern, arguments.get("params", {}))
            return CallToolResult(content=[TextContent(type="text", text=result)])

        elif name == "jaa_system":
            action = arguments["action"]
            target = arguments.get("target", "")
            params = arguments.get("params", {})

            result = await _handle_system_action(orchestrator.system_agent, action, target, params)
            return CallToolResult(content=[TextContent(type="text", text=result)])

        elif name == "jaa_memory":
            action = arguments["action"]

            if action == "search":
                results = await orchestrator.memory.search(arguments["query"])
                return CallToolResult(content=[TextContent(type="text", text=json.dumps(_results_to_json(results), indent=2))])

            elif action == "store_fact":
                fact_id = await orchestrator.memory.learn_fact(
                    arguments["fact"],
                    arguments.get("category", "general"),
                )
                return CallToolResult(content=[TextContent(type="text", text=f"Stored fact with ID: {fact_id}")])

            elif action == "get_preference":
                value = await orchestrator.memory.get_preference(arguments["key"])
                return CallToolResult(content=[TextContent(type="text", text=str(value) if value else "Not set")])

            elif action == "set_preference":
                pref_id = await orchestrator.memory.set_preference(
                    arguments["key"],
                    arguments["value"],
                    arguments.get("context", ""),
                )
                return CallToolResult(content=[TextContent(type="text", text=f"Set preference: {pref_id}")])

            elif action == "stats":
                stats = orchestrator.memory.get_stats()
                return CallToolResult(content=[TextContent(type="text", text=json.dumps(stats, indent=2))])

        elif name == "jaa_index":
            action = arguments["action"]

            if action == "index":
                stats = await orchestrator.memory.index_codebase(force=arguments.get("force", False))
                return CallToolResult(content=[TextContent(type="text", text=f"Indexing complete: {stats}")])

            elif action == "search":
                results = await orchestrator.memory.codebase_indexer.search_code(arguments["query"])
                return CallToolResult(content=[TextContent(type="text", text=json.dumps(_results_to_json(results), indent=2))])

            elif action == "stats":
                stats = orchestrator.memory.codebase_indexer.get_stats()
                return CallToolResult(content=[TextContent(type="text", text=json.dumps(stats, indent=2))])

        raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        logger.exception(f"Tool {name} failed")
        return CallToolResult(
            content=[TextContent(type="text", text=f"Error: {str(e)}")],
            isError=True,
        )


async def _handle_desktop_action(agent, action: str, target: str, params: dict) -> str:
    """Handle desktop automation actions."""
    if action == "open":
        success = await agent.apps.launch(target)
        return f"Opened {target}" if success else f"Failed to open {target}"

    elif action == "close":
        success = await agent.apps.close(target)
        return f"Closed {target}" if success else f"Failed to close {target}"

    elif action == "focus":
        success = await agent.apps.activate(target)
        return f"Focused {target}" if success else f"Could not focus {target}"

    elif action == "arrange":
        success = await agent.arrange_windows(target or "coding")
        return f"Arranged windows ({target or 'coding'})" if success else "Failed to arrange windows"

    elif action == "type":
        await agent.input.type_text(target)
        return f"Typed: {target[:50]}..."

    elif action == "click":
        x, y = params.get("x", 0), params.get("y", 0)
        await agent.input.click(x, y)
        return f"Clicked at ({x}, {y})"

    elif action == "screenshot":
        path = await agent.screen.capture()
        return f"Screenshot saved to {path}"

    elif action == "shortcut":
        await agent.input.press_keys(target)
        return f"Pressed shortcut: {target}"

    elif action == "switch":
        success = await agent.apps.switch(target)
        return f"Switched to {target}" if success else f"Could not switch to {target}"

    raise ValueError(f"Unknown desktop action: {action}")


def _results_to_json(results) -> list[dict]:
    """Serialize RetrievalResult objects into plain JSON-safe dicts."""
    if isinstance(results, dict):
        out = []
        for section, items in results.items():
            for r in items or []:
                out.append({
                    "section": section,
                    "score": round(getattr(r, "score", 0.0) or 0.0, 4),
                    "rank": getattr(r, "rank", 0),
                    "content": (r.entry.content if r.entry else "")[:500],
                    "metadata": r.entry.metadata if r.entry else {},
                })
        return out
    out = []
    for r in results or []:
        out.append({
            "score": round(getattr(r, "score", 0.0) or 0.0, 4),
            "rank": getattr(r, "rank", 0),
            "content": (r.entry.content if r.entry else "")[:500],
            "metadata": r.entry.metadata if r.entry else {},
        })
    return out


async def _handle_file_action(orchestrator, action: str, path: str, content: str | None, pattern: str, params: dict) -> str:
    """Handle file operations (project-scoped via the code agent's FileOperations)."""
    files = orchestrator.code_agent.files

    if action == "read":
        try:
            return files.read_file(path)
        except Exception as e:
            return f"Error reading {path}: {e}"

    elif action == "write":
        if content is None:
            return "Error: content required for write"
        try:
            files.write_file(path, content)
            return f"Written to {path}"
        except Exception as e:
            return f"Error writing {path}: {e}"

    elif action == "list":
        try:
            files_list = files.list_files(pattern if pattern not in ("", "*") else "**/*")
            return "\n".join(files_list[:200]) if files_list else "No files found"
        except Exception as e:
            return f"Error listing {path}: {e}"

    elif action == "search":
        try:
            results = files.find_files(path or ".", pattern, params.get("content_pattern"))
            return "\n".join(results[:200]) if results else "No matches"
        except Exception as e:
            return f"Error searching: {e}"

    elif action == "organize":
        try:
            result = await orchestrator.desktop_agent.files.organize_downloads()
            return f"Organized: {result}"
        except Exception as e:
            return f"Error organizing: {e}"

    elif action == "delete":
        try:
            files.delete_file(path)
            return f"Deleted {path}"
        except Exception as e:
            return f"Error deleting: {e}"

    elif action == "move":
        dst = params.get("destination", "")
        if not dst:
            return "Error: destination required for move"
        try:
            files.move_file(path, dst)
            return f"Moved {path} to {dst}"
        except Exception as e:
            return f"Error moving: {e}"

    elif action == "copy":
        dst = params.get("destination", "")
        if not dst:
            return "Error: destination required for copy"
        try:
            files.copy_file(path, dst)
            return f"Copied {path} to {dst}"
        except Exception as e:
            return f"Error copying: {e}"

    raise ValueError(f"Unknown file action: {action}")


async def _handle_system_action(agent, action: str, target: str, params: dict) -> str:
    """Handle system operations."""
    if action == "status":
        status = await agent.get_system_status()
        return f"CPU: {status['cpu']['total']:.1f}%\nMemory: {status['memory']['percent']:.1f}%\nDisk: {status['disk']['percent']:.1f}%"

    elif action == "processes":
        processes = await agent.list_top_processes(10)
        lines = ["Top processes:"]
        for p in processes:
            lines.append(f"  {p['pid']}: {p['name']} - CPU: {p['cpu_percent']:.1f}% - Mem: {p['memory_mb']:.1f}MB")
        return "\n".join(lines)

    elif action == "ports":
        port = int(target) if target.isdigit() else 0
        if port:
            check = await agent.check_port(port)
            return f"Port {port}: {'IN USE by ' + check['process']['name'] if check['in_use'] else 'FREE'}"
        else:
            ports = [80, 443, 22, 3306, 5432, 6379, 8080, 3000, 5000, 8000]
            results = []
            for p in ports:
                check = await agent.check_port(p)
                if check["in_use"]:
                    results.append(f"Port {p}: IN USE by {check['process'].get('name', 'unknown')}")
            return "Listening ports:\n" + "\n".join(results) if results else "No common ports in use"

    elif action == "network":
        return "Network diagnostics not yet implemented"

    elif action == "service":
        return "Service management not yet implemented"

    raise ValueError(f"Unknown system action: {action}")


async def run_server(host: str = "127.0.0.1", port: int = 8000) -> None:
    """Run MCP server over stdio (for IDE integration)."""
    logger.info("Starting J.A.A. MCP server...")

    # Initialize orchestrator
    await initialize_orchestrator()

    # Run over stdio for MCP
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    import json
    asyncio.run(run_server())