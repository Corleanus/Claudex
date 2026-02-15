"""
Claudex v2 -- Hologram Sidecar TCP Server

Asyncio TCP server speaking NDJSON protocol. Each connection receives one
request, gets routed, and receives one response before the connection closes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

logger = logging.getLogger("claudex.sidecar")

# Type aliases
Request = Dict[str, Any]
Response = Dict[str, Any]


def _error_response(request_id: str, message: str) -> Response:
    return {"id": request_id, "type": "error", "payload": {"error_message": message}}


def _handle_ping(req: Request) -> Response:
    return {"id": req["id"], "type": "pong", "payload": {}}


def _handle_query(req: Request) -> Response:
    """Process a hologram context query.

    Phase 1: Returns empty pressure arrays. The hologram-cognitive pressure
    engine is not yet integrated — callers degrade to Tier 3 (recency fallback)
    or Tier 4 (FTS5 only) as designed. This is intentional, NOT a bug.

    Phase 2+ will wire in system.process_turn() -> router.get_context() here.
    """
    prompt = req.get("payload", {}).get("prompt", "")
    logger.debug("Query received (prompt length: %d chars)", len(prompt))
    return {
        "id": req["id"],
        "type": "result",
        "payload": {"hot": [], "warm": [], "cold": []},
    }


def _handle_update(req: Request) -> Response:
    # Stub: acknowledge. When integrated, will call
    # system.notify_file_changes(files)
    return {"id": req["id"], "type": "result", "payload": {}}


_HANDLERS = {
    "ping": _handle_ping,
    "query": _handle_query,
    "update": _handle_update,
}


def route_request(req: Request) -> Response:
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

    return handler(req)


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

            start = time.monotonic()
            resp = route_request(req)
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
        except Exception:
            logger.exception("Error handling connection from %s", peer)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
