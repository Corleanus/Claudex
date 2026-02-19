"""
Claudex v2 -- Hologram Sidecar TCP Server

Asyncio TCP server speaking NDJSON protocol. Each connection receives one
request, gets routed, and receives one response before the connection closes.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("claudex.sidecar")

# Type aliases
Request = Dict[str, Any]
Response = Dict[str, Any]

# Lazy import: hologram may not be installed
_Session = None

def _get_session_class():
    global _Session
    if _Session is None:
        from hologram import Session
        _Session = Session
    return _Session

# Module-level session cache (persists across requests within same sidecar process)
_session_cache: dict[str, object] = {}
_session_locks: dict[str, asyncio.Lock] = {}

def _canonical_dir(claude_dir: str) -> str:
    """Normalize claude_dir to a canonical path to prevent lock/cache aliasing."""
    return os.path.realpath(os.path.expanduser(claude_dir))

def _get_session(claude_dir: str):
    """Get or create a cached Session for the given claude_dir."""
    canonical = _canonical_dir(claude_dir)
    if canonical not in _session_cache:
        SessionCls = _get_session_class()
        _session_cache[canonical] = SessionCls(canonical)
    return _session_cache[canonical]

def _get_lock(claude_dir: str) -> asyncio.Lock:
    """Get or create a per-session asyncio lock to serialize turn()+save()."""
    canonical = _canonical_dir(claude_dir)
    if canonical not in _session_locks:
        _session_locks[canonical] = asyncio.Lock()
    return _session_locks[canonical]


def _error_response(request_id: str, message: str) -> Response:
    return {"id": request_id, "type": "error", "payload": {"error_message": message}}


def _handle_ping(req: Request) -> Response:
    return {"id": req["id"], "type": "pong", "payload": {}}


async def _handle_query(req: Request) -> Response:
    """Process a hologram context query via Session.turn()."""
    # H27: Validate request structure before reading payload
    if "id" not in req:
        return _error_response("unknown", "Missing 'id' field")

    if "type" not in req:
        return _error_response(req["id"], "Missing 'type' field")

    payload = req.get("payload", {})
    prompt = payload.get("prompt", "")
    claude_dir = payload.get("claude_dir", "")

    if not claude_dir:
        claude_dir = os.path.expanduser("~/.claude")

    logger.debug("Query received (prompt length: %d chars, claude_dir: %s)", len(prompt), claude_dir)

    try:
        lock = _get_lock(claude_dir)
        async with lock:
            session = _get_session(claude_dir)
            result = await asyncio.to_thread(session.turn, prompt)
            await asyncio.to_thread(session.save)

        return {
            "id": req["id"],
            "type": "result",
            "payload": {
                "hot": result.hot,
                "warm": result.warm,
                "cold": result.cold,
                "turn": result.turn_number,
                "tension": getattr(result, "tension", 0.0),
                "cluster_size": getattr(result, "cluster_size", 0),
            },
        }
    except Exception as e:
        logger.exception("Error handling query for claude_dir=%s", claude_dir)
        return {
            "id": req["id"],
            "type": "error",
            "payload": {"error_message": str(e)},
        }


async def _handle_update(req: Request) -> Response:
    """Acknowledge update. Hologram discovers files from disk — no action needed."""
    return {"id": req["id"], "type": "result", "payload": {}}


_HANDLERS = {
    "ping": _handle_ping,
    "query": _handle_query,
    "update": _handle_update,
}


async def route_request(req: Request) -> Response:
    """Route an incoming request dict to the appropriate handler."""
    req_id: Optional[str] = req.get("id")
    if req_id is None:
        return _error_response("unknown", "Missing 'id' field")

    req_type: Optional[str] = req.get("type")
    if req_type is None:
        return _error_response(req_id, "Missing 'type' field")

    if req_type == "shutdown":
        # Handled specially by the server (triggers graceful exit)
        return {"id": req_id, "type": "result", "payload": {}}

    handler = _HANDLERS.get(req_type)
    if handler is None:
        return _error_response(req_id, f"Unknown request type: {req_type}")

    result = handler(req)
    if inspect.isawaitable(result):
        return await result
    return result


class SidecarServer:
    """Asyncio TCP server implementing the Claudex NDJSON sidecar protocol."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0) -> None:
        self.host = host
        self.port = port  # 0 = OS assigns
        self._server: Optional[asyncio.AbstractServer] = None
        self._shutdown_event: Optional[asyncio.Event] = None

    @property
    def assigned_port(self) -> int:
        """Return the actual port after bind. Only valid after start()."""
        if self._server is None:
            raise RuntimeError("Server not started")
        socks = self._server.sockets
        if not socks:
            raise RuntimeError("Server has no sockets")
        return socks[0].getsockname()[1]

    async def start(self) -> int:
        """Bind the server and begin accepting connections. Returns the assigned port."""
        self._shutdown_event = asyncio.Event()
        self._server = await asyncio.start_server(
            self._handle_connection, self.host, self.port
        )
        assigned = self.assigned_port
        logger.info("Sidecar server listening on %s:%d", self.host, assigned)
        return assigned

    async def serve_forever(self) -> None:
        """Run until shutdown is triggered."""
        if self._server is None or self._shutdown_event is None:
            raise RuntimeError("Call start() before serve_forever()")
        async with self._server:
            await self._shutdown_event.wait()
        logger.info("Sidecar server shut down")

    def request_shutdown(self) -> None:
        """Signal the server to stop accepting connections and exit."""
        if self._shutdown_event is not None:
            self._shutdown_event.set()
        if self._server is not None:
            self._server.close()

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        """Handle a single TCP connection: read request, route, write response, close."""
        peer = writer.get_extra_info("peername")
        logger.debug("Connection from %s", peer)
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=5.0)
            if not line:
                return

            text = line.decode("utf-8").strip()
            if not text:
                return

            try:
                req = json.loads(text)
            except json.JSONDecodeError as exc:
                resp = _error_response("unknown", f"Malformed JSON: {exc}")
                writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                await writer.drain()
                return

            # H26: Validate that parsed JSON is a dict
            if not isinstance(req, dict):
                resp = {"id": "unknown", "type": "error", "payload": {"error": "invalid request format", "code": "BAD_REQUEST"}}
                writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                await writer.drain()
                return

            start = time.monotonic()
            resp = await route_request(req)
            elapsed_ms = round((time.monotonic() - start) * 1000, 1)
            resp["timing_ms"] = elapsed_ms

            writer.write((json.dumps(resp) + "\n").encode("utf-8"))
            await writer.drain()

            # Handle shutdown request: respond first, then signal exit
            if req.get("type") == "shutdown":
                logger.info("Shutdown requested by client")
                self.request_shutdown()

        except asyncio.TimeoutError:
            logger.warning("Connection from %s timed out reading request", peer)
        except Exception as e:
            # H28: Catch-all handler sends error response instead of leaving client hanging
            logger.exception("Error handling connection from %s", peer)
            try:
                resp = _error_response("unknown", f"Internal server error: {e}")
                writer.write((json.dumps(resp) + "\n").encode("utf-8"))
                await writer.drain()
            except Exception:
                logger.exception("Failed to send error response")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
