"""
Claudex v2 -- Hologram Sidecar Entry Point

Usage:
    python -m sidecar.main --port-file ~/.claudex/db/hologram.port [--config <path>]

Starts the TCP sidecar server, writes port and PID files, and runs until
SIGTERM/SIGINT or a shutdown request arrives over the protocol.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import logging
import os
import signal
import sys
from pathlib import Path

from .server import SidecarServer

logger = logging.getLogger("claudex.sidecar")

# Files we need to clean up on exit
_cleanup_files: list[Path] = []


def _cleanup() -> None:
    """Remove port and PID files."""
    for f in _cleanup_files:
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Claudex hologram sidecar TCP server"
    )
    parser.add_argument(
        "--port-file",
        type=Path,
        required=True,
        help="Path to write the assigned TCP port number",
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to hologram config file (reserved for future use)",
    )
    return parser.parse_args(argv)


def _setup_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    root = logging.getLogger("claudex.sidecar")
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(logging.INFO)


async def _run(args: argparse.Namespace) -> None:
    server = SidecarServer(host="127.0.0.1", port=0)
    assigned_port = await server.start()

    # Derive PID file path: sibling of port file, named hologram.pid
    port_file: Path = args.port_file
    pid_file = port_file.parent / "hologram.pid"

    # Ensure parent directory exists
    port_file.parent.mkdir(parents=True, exist_ok=True)

    # Write port file AFTER successful bind
    port_file.write_text(str(assigned_port), encoding="utf-8")
    _cleanup_files.append(port_file)
    logger.info("Port file written: %s (port %d)", port_file, assigned_port)

    # Write PID file
    pid_file.write_text(str(os.getpid()), encoding="utf-8")
    _cleanup_files.append(pid_file)
    logger.info("PID file written: %s (pid %d)", pid_file, os.getpid())

    # Register atexit cleanup (works on Windows where SIGTERM is unavailable)
    atexit.register(_cleanup)

    # Register signal handlers for graceful shutdown (Unix)
    loop = asyncio.get_running_loop()
    for sig_name in ("SIGTERM", "SIGINT"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                loop.add_signal_handler(sig, server.request_shutdown)
            except NotImplementedError:
                # Windows: add_signal_handler not supported for all signals
                pass

    logger.info("Sidecar ready on 127.0.0.1:%d", assigned_port)

    await server.serve_forever()

    # Clean up files on normal shutdown path too
    _cleanup()


def main(argv: list[str] | None = None) -> None:
    _setup_logging()
    args = _parse_args(argv)
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        logger.info("Interrupted by keyboard")
    finally:
        _cleanup()


if __name__ == "__main__":
    main()
