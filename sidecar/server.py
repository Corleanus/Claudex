"""
Claudex v2 -- Hologram Sidecar TCP Server

Asyncio TCP server speaking NDJSON protocol. Each connection receives one
request, gets routed, and receives one response before the connection closes.
"""

from __future__ import annotations

import asyncio
import fnmatch
import inspect
import json
import logging
import os
import pathlib
import time
from collections import OrderedDict
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

# Module-level session cache keyed by (claude_dir, project_dir) — LRU, max 3
_MAX_CACHED_SESSIONS = 3
_session_cache: OrderedDict[tuple[str, str], object] = OrderedDict()
_session_locks: dict[tuple[str, str], asyncio.Lock] = {}

# Mtime cache for incremental project file scanning: (project_dir) -> {path: mtime}
_mtime_cache: dict[str, dict[str, float]] = {}
# Content cache: (project_dir) -> {path: content}
_content_cache: dict[str, dict[str, str]] = {}

def _canonical_dir(path: str) -> str:
    """Normalize a directory path to canonical form to prevent aliasing."""
    if not path:
        return ""
    return os.path.realpath(os.path.expanduser(path))

def _cache_key(claude_dir: str, project_dir: str) -> tuple[str, str]:
    """Compute the session cache key from claude_dir and project_dir."""
    return (_canonical_dir(claude_dir), _canonical_dir(project_dir))

def _get_session(claude_dir: str, project_dir: str = ""):
    """Get or create a cached Session for the given (claude_dir, project_dir).

    Uses LRU eviction — oldest session is dropped when cache exceeds _MAX_CACHED_SESSIONS.
    """
    key = _cache_key(claude_dir, project_dir)
    if key in _session_cache:
        _session_cache.move_to_end(key)
        return _session_cache[key]

    SessionCls = _get_session_class()
    session = SessionCls(key[0])  # Session is always rooted at claude_dir
    _session_cache[key] = session
    _session_cache.move_to_end(key)

    # LRU eviction
    while len(_session_cache) > _MAX_CACHED_SESSIONS:
        evicted_key, _ = _session_cache.popitem(last=False)
        _session_locks.pop(evicted_key, None)
        logger.debug("Evicted session cache entry: %s", evicted_key)

    return session

def _get_lock(claude_dir: str, project_dir: str = "") -> asyncio.Lock:
    """Get or create a per-session asyncio lock to serialize turn()+save()."""
    key = _cache_key(claude_dir, project_dir)
    if key not in _session_locks:
        _session_locks[key] = asyncio.Lock()
    return _session_locks[key]


# Default project file patterns
_DEFAULT_PATTERNS = ["*.md", "*.ts", "*.py", "**/*.md", "**/*.ts", "**/*.py"]
_DEFAULT_EXCLUDES = [
    "node_modules/**", ".git/**", "dist/**", "build/**", "coverage/**",
    "**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx", "**/*.spec.tsx",
    "**/test_*.py", "**/*_test.py", "**/tests/**",
]
_DEFAULT_MAX_FILES = 200


def _matches_any(rel_path: str, patterns: list[str]) -> bool:
    """Check if a relative path matches any of the given glob patterns."""
    rel_posix = pathlib.PurePosixPath(rel_path).as_posix()
    for pattern in patterns:
        if fnmatch.fnmatch(rel_posix, pattern):
            return True
        # Also check just the filename for non-recursive patterns
        if "/" not in pattern and fnmatch.fnmatch(pathlib.PurePosixPath(rel_path).name, pattern):
            return True
    return False


def _scan_project_files(project_dir: str, config: dict) -> dict[str, str]:
    """Scan project directory for files matching configured patterns.

    Runs OUTSIDE the session lock (I/O heavy, no session mutation).
    Uses mtime caching to skip re-reads of unchanged files.

    Returns dict mapping 'project:<relative_path>' keys to file content.
    """
    patterns = config.get("patterns", _DEFAULT_PATTERNS)
    excludes = config.get("exclude", _DEFAULT_EXCLUDES)
    max_files = config.get("max_files", _DEFAULT_MAX_FILES)

    canonical_proj = _canonical_dir(project_dir)
    proj_path = pathlib.Path(canonical_proj)

    # Get previous mtime/content caches for this project
    prev_mtimes = _mtime_cache.get(canonical_proj, {})
    prev_contents = _content_cache.get(canonical_proj, {})

    new_mtimes: dict[str, float] = {}
    result: dict[str, str] = {}
    file_count = 0

    try:
        for root, dirs, files in os.walk(canonical_proj):
            root_path = pathlib.Path(root)
            rel_root = root_path.relative_to(proj_path).as_posix()
            if rel_root == ".":
                rel_root = ""

            # Prune excluded directories early
            dirs[:] = [
                d for d in dirs
                if not _matches_any(
                    (rel_root + "/" + d if rel_root else d) + "/dummy",
                    excludes,
                )
                # Always skip hidden dirs and common large dirs
                and not d.startswith(".")
                and d not in ("node_modules", "__pycache__", ".git")
            ]

            for fname in files:
                if file_count >= max_files:
                    break

                rel_file = (rel_root + "/" + fname) if rel_root else fname

                # Check include patterns
                if not _matches_any(rel_file, patterns):
                    continue
                # Check exclude patterns
                if _matches_any(rel_file, excludes):
                    continue

                full_path = os.path.join(root, fname)
                key = f"project:{rel_file}"

                try:
                    mtime = os.path.getmtime(full_path)
                except OSError:
                    continue

                new_mtimes[key] = mtime

                # Use cached content if mtime unchanged
                if key in prev_mtimes and prev_mtimes[key] == mtime and key in prev_contents:
                    result[key] = prev_contents[key]
                else:
                    try:
                        with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                            content = f.read()
                        result[key] = content
                    except OSError:
                        continue

                file_count += 1

            if file_count >= max_files:
                break
    except OSError as e:
        logger.warning("Error scanning project directory %s: %s", project_dir, e)

    # Update caches
    _mtime_cache[canonical_proj] = new_mtimes
    _content_cache[canonical_proj] = result

    logger.debug("Scanned %d project files from %s", len(result), project_dir)
    return result


def _inject_project_files(session: object, project_files: dict[str, str]) -> None:
    """Inject project files into a hologram Session.

    Runs INSIDE the session lock (mutates session state).
    Tracks newly-added files and bootstraps them to WARM pressure.
    """
    newly_added: list[str] = []
    content_changed = False

    for key, content in project_files.items():
        if key not in session.system.files:
            session.system.add_file(key, content, rebuild_dag=False)
            newly_added.append(key)
        elif session.system.files[key].content != content:
            session.system.update_file(key, content)
            content_changed = True

    # Only rebuild DAG if files were actually added or changed (Codex finding #2)
    if newly_added or content_changed:
        session.system._rebuild_dag()

    # Bootstrap ONLY newly-added files to WARM (Codex CRITICAL #3: once, not every query)
    for key in newly_added:
        f = session.system.files[key]
        f.raw_pressure = 0.45       # Above WARM threshold (0.426)
        f.pressure_bucket = 22      # Solidly in WARM range (>=20 is WARM)

    if newly_added:
        logger.debug("Injected %d new project files (bootstrapped to WARM)", len(newly_added))


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
    project_dir = payload.get("project_dir", "")
    project_config = payload.get("project_config", {})
    boost_files = payload.get("boost_files", [])

    if not claude_dir:
        claude_dir = os.path.expanduser("~/.claude")

    logger.debug(
        "Query received (prompt length: %d chars, claude_dir: %s, project_dir: %s)",
        len(prompt), claude_dir, project_dir or "(global)",
    )

    try:
        # Step 1: Scan project files OUTSIDE lock (I/O heavy, no session mutation)
        project_files: dict[str, str] = {}
        if project_dir and os.path.isdir(project_dir):
            project_files = _scan_project_files(project_dir, project_config)

        # Step 2: Lock, inject, boost, query
        lock = _get_lock(claude_dir, project_dir)
        async with lock:
            session = _get_session(claude_dir, project_dir)

            if project_files:
                _inject_project_files(session, project_files)

            # Apply boost for post-compact active files
            for bf in boost_files:
                key = f"project:{bf}" if not bf.startswith("project:") else bf
                if key in session.system.files:
                    f = session.system.files[key]
                    f.raw_pressure = max(f.raw_pressure, 0.6)
                    f.pressure_bucket = max(f.pressure_bucket, 30)

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
