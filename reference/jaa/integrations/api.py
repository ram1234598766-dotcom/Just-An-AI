"""
REST API server for J.A.A.

A small, dependency-free HTTP API (stdlib ``http.server`` only) so J.A.A.
can be scripted, embedded in other tools, or driven from the browser.

Endpoints:
  GET  /health           -> health + version
  GET  /v1/models        -> configured models per provider
  POST /v1/chat          -> {"message": str, "voice_mode": bool?}
  POST /v1/code          -> {"task": str, "file": str?, "language": str?, "action": str?}
  POST /v1/memory/search -> {"query": str}

The orchestrator lives on an asyncio loop in the main thread; each HTTP
request runs in a worker thread and dispatches onto that loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from jaa import __version__

logger = logging.getLogger(__name__)

_orchestrator: Any | None = None
_loop: asyncio.AbstractEventLoop | None = None


def set_orchestrator(orchestrator: Any, loop: asyncio.AbstractEventLoop) -> None:
    """Point the API server at a running orchestrator + event loop."""
    global _orchestrator, _loop
    _orchestrator = orchestrator
    _loop = loop


def _run(coro: Any, timeout: float = 600.0) -> Any:
    """Run an async coroutine from a worker thread (blocks until done)."""
    if _loop is None or _orchestrator is None:
        raise RuntimeError("API server not initialized")
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


class JAAAPIHandler(BaseHTTPRequestHandler):
    """HTTP handler for the J.A.A. REST API."""

    server_version = "JAA/" + __version__

    # ------------------------------------------------------------------ utils
    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("api %s - %s", self.address_string(), fmt % args)

    # ------------------------------------------------------------------ verbs
    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server API)
        self._send(200, {})

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        try:
            if self.path in ("/", "/health"):
                self._send(200, {"status": "ok", "app": "J.A.A.", "version": __version__})
                return
            if self.path == "/v1/models":
                if _orchestrator is None:
                    self._send(503, {"error": "orchestrator not initialized"})
                    return
                self._send(200, {"models": _orchestrator.llm.get_available_models()})
                return
            self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - keep the API alive on any error
            logger.exception("GET %s failed", self.path)
            self._send(500, {"error": str(e)})

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        try:
            if _orchestrator is None:
                self._send(503, {"error": "orchestrator not initialized"})
                return
            data = self._read_json()

            if self.path == "/v1/chat":
                message = (data.get("message") or "").strip()
                if not message:
                    self._send(400, {"error": "message is required"})
                    return
                response = _run(_orchestrator.process_text(message, voice_mode=bool(data.get("voice_mode", False))))
                self._send(200, {"response": response})
                return

            if self.path == "/v1/code":
                from jaa.agents.code_agent import CodeContext

                task = (data.get("task") or "").strip()
                if not task:
                    self._send(400, {"error": "task is required"})
                    return
                file_path = data.get("file")
                language = data.get("language") or "python"
                action = data.get("action") or "generate"
                prompt = f"{action.capitalize()} {language} code: {task}"
                if file_path:
                    prompt += f" in {file_path}"
                context = CodeContext(
                    project_root=_orchestrator.project_root,
                    current_file=Path(file_path) if file_path else None,
                    language=language,
                )
                result = _run(_orchestrator.code_agent.execute(prompt, context))
                self._send(200, {"response": result})
                return

            if self.path == "/v1/memory/search":
                query = (data.get("query") or "").strip()
                if not query:
                    self._send(400, {"error": "query is required"})
                    return
                results = _run(_orchestrator.memory.search(query))
                self._send(200, {"results": _serialize_results(results)})
                return

            self._send(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001
            logger.exception("POST %s failed", self.path)
            self._send(500, {"error": str(e)})


def _serialize_results(results) -> list[dict]:
    """Convert retrieval results into JSON-safe dicts."""
    if isinstance(results, dict):
        out = []
        for section, items in results.items():
            for r in items or []:
                out.append({
                    "section": section,
                    "score": round(getattr(r, "score", 0.0) or 0.0, 4),
                    "content": (r.entry.content if r.entry else "")[:500],
                    "metadata": r.entry.metadata if r.entry else {},
                })
        return out
    out = []
    for r in results or []:
        out.append({
            "score": round(getattr(r, "score", 0.0) or 0.0, 4),
            "content": (r.entry.content if r.entry else "")[:500],
            "metadata": r.entry.metadata if r.entry else {},
        })
    return out


async def serve_api(project_root: Path, host: str = "127.0.0.1", port: int = 8000) -> None:
    """Run the REST API server until interrupted."""
    from jaa.core.orchestrator import JAAOrchestrator

    orchestrator = JAAOrchestrator(project_root)
    await orchestrator.initialize()

    loop = asyncio.get_running_loop()
    set_orchestrator(orchestrator, loop)

    server = ThreadingHTTPServer((host, port), JAAAPIHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    logger.info("J.A.A. API listening on http://%s:%d", host, port)

    try:
        while True:
            await asyncio.sleep(3600)
    finally:
        server.shutdown()
        await orchestrator.shutdown()


__all__ = ["JAAAPIHandler", "serve_api", "set_orchestrator"]
