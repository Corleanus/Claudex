/**
 * Claudex v2 — Sidecar Process Manager (WP-05)
 *
 * Manages the hologram-cognitive Python sidecar lifecycle:
 * spawn, stop, restart, health-check, orphan cleanup.
 *
 * The sidecar is a long-lived TCP server that outlives hook processes.
 * Port coordination via port file; PID tracking via PID file.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadConfig } from '../shared/config.js';
import { HologramError, HologramUnavailableError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { PATHS } from '../shared/paths.js';
import { ProtocolHandler, buildRequest } from './protocol.js';

const log = createLogger('hologram-sidecar');

const PORT_POLL_INTERVAL_MS = 200;
const PORT_POLL_TIMEOUT_MS = 5000;
const STOP_GRACE_MS = 3000;

/** Timeout for the ping verification probe (shorter than normal requests). */
const PING_PROBE_TIMEOUT_MS = 1500;

/**
 * Check whether a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a numeric value from a file. Returns null if missing or non-numeric.
 */
function readNumericFile(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Remove a file if it exists. Never throws.
 */
function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone or permission issue — nothing we can do.
  }
}

/**
 * Send a ping to a port and verify the response is a valid hologram sidecar pong.
 * Returns 'ours' if the sidecar responds correctly, 'foreign' if the port is occupied
 * by something else, or 'dead' if nothing is listening.
 */
async function verifySidecarPing(port: number): Promise<'ours' | 'foreign' | 'dead'> {
  try {
    const protocol = new ProtocolHandler(PING_PROBE_TIMEOUT_MS);
    const request = buildRequest('ping');
    const response = await protocol.send(port, request);
    return response.type === 'pong' ? 'ours' : 'foreign';
  } catch (err: unknown) {
    // HologramUnavailableError with ECONNREFUSED → nothing listening
    if (
      err instanceof Error &&
      (err.message.includes('connection refused') || err.message.includes('ECONNREFUSED'))
    ) {
      return 'dead';
    }
    // Timeout, malformed response, id mismatch → foreign process
    return 'foreign';
  }
}

/**
 * Poll for a file to appear on disk.
 */
function waitForFile(filePath: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now();
    const check = () => {
      if (fs.existsSync(filePath)) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, intervalMs);
    };
    check();
  });
}

export class SidecarManager {
  private proc: ChildProcess | null = null;

  /**
   * Start the hologram sidecar process.
   *
   * If a sidecar is already running (PID file exists, process alive, port reachable),
   * reuses it. Cleans up orphaned PID/port files from dead processes.
   */
  async start(): Promise<void> {
    // --- Double-start protection: check existing PID ---
    const existingPid = readNumericFile(PATHS.hologramPid);

    if (existingPid !== null) {
      if (isProcessAlive(existingPid)) {
        const existingPort = readNumericFile(PATHS.hologramPort);

        if (existingPort !== null) {
          // Verify the port is actually our sidecar via NDJSON ping, not just a raw probe.
          // This catches: (a) foreign process occupying the port, (b) stale port from
          // a dead sidecar whose PID was recycled by the OS.
          const status = await verifySidecarPing(existingPort);

          if (status === 'ours') {
            log.info('Sidecar already running (ping verified)', { pid: existingPid, port: existingPort });
            return;
          }

          if (status === 'foreign') {
            // Something else is listening on our port — don't kill it, just discard our stale port file.
            // The spawn below will use port 0 (OS-assigned) to avoid conflict.
            log.warn('Foreign process occupies sidecar port, will pick a new port', {
              pid: existingPid,
              port: existingPort,
            });
            safeUnlink(PATHS.hologramPort);
          } else {
            // 'dead' — port unreachable even though process alive — stale port file
            log.warn('Sidecar process alive but port unreachable, cleaning up', {
              pid: existingPid,
              port: existingPort,
            });
            safeUnlink(PATHS.hologramPort);
          }
        }

        // Process alive but no valid port — kill and restart
        log.warn('Sidecar process alive but no valid port, killing', { pid: existingPid });
        try {
          process.kill(existingPid);
        } catch {
          // Already dead by the time we tried
        }
        safeUnlink(PATHS.hologramPid);
      } else {
        // Orphan: PID file exists but process dead.
        // Port file may also be stale — but check if a foreign process now occupies the port.
        const orphanPort = readNumericFile(PATHS.hologramPort);
        if (orphanPort !== null) {
          const status = await verifySidecarPing(orphanPort);
          if (status === 'foreign') {
            log.warn('Orphaned PID file and foreign process on port, discarding port file', {
              pid: existingPid,
              port: orphanPort,
            });
          } else {
            log.warn('Orphaned sidecar PID file, cleaning up', { pid: existingPid });
          }
          safeUnlink(PATHS.hologramPort);
        } else {
          log.warn('Orphaned sidecar PID file, cleaning up', { pid: existingPid });
        }
        safeUnlink(PATHS.hologramPid);
      }
    }

    // --- Pre-spawn port check: verify port file isn't left from a crash ---
    // Handles the edge case where PID file is missing but port file remains.
    const stalePort = readNumericFile(PATHS.hologramPort);
    if (stalePort !== null) {
      const status = await verifySidecarPing(stalePort);
      if (status === 'ours') {
        // A sidecar is running without a PID file — adopt it
        log.info('Found running sidecar without PID file, reusing', { port: stalePort });
        return;
      }
      if (status === 'foreign') {
        log.warn('Foreign process on stale port, discarding port file', { port: stalePort });
      }
      safeUnlink(PATHS.hologramPort);
    }

    // --- Spawn new sidecar ---
    const config = loadConfig();
    const pythonPath = config.hologram?.python_path ?? 'python';
    const sidecarPath = config.hologram?.sidecar_path;

    if (!sidecarPath) {
      throw new HologramUnavailableError(
        'hologram.sidecar_path not configured — cannot start sidecar',
      );
    }

    // Ensure db directory exists (for port/pid files)
    fs.mkdirSync(path.dirname(PATHS.hologramPort), { recursive: true });

    // Ensure log directory exists
    fs.mkdirSync(PATHS.hookLogs, { recursive: true });

    const stderrLogPath = path.join(PATHS.hookLogs, 'hologram-sidecar.log');
    const stderrStream = fs.openSync(stderrLogPath, 'a');

    const configPath = PATHS.config;

    log.info('Starting sidecar', { python: pythonPath, sidecar: sidecarPath });

    this.proc = spawn(
      pythonPath,
      [
        sidecarPath,
        '--port-file', PATHS.hologramPort,
        '--config', configPath,
      ],
      {
        stdio: ['ignore', 'ignore', stderrStream],
        cwd: path.dirname(sidecarPath),
        detached: true,
      },
    );

    this.proc.unref();

    // Close the stderr fd in this process since child owns it now
    fs.closeSync(stderrStream);

    if (this.proc.pid == null) {
      this.proc = null;
      throw new HologramError('Failed to spawn sidecar process — no PID returned');
    }

    // Write PID file
    fs.writeFileSync(PATHS.hologramPid, String(this.proc.pid), 'utf-8');

    // Handle unexpected exit during startup
    let exitedDuringStartup = false;
    const onExit = () => {
      exitedDuringStartup = true;
    };
    this.proc.once('exit', onExit);

    // Poll for port file
    const portAppeared = await waitForFile(
      PATHS.hologramPort,
      PORT_POLL_TIMEOUT_MS,
      PORT_POLL_INTERVAL_MS,
    );

    this.proc.removeListener('exit', onExit);

    if (exitedDuringStartup) {
      safeUnlink(PATHS.hologramPid);
      safeUnlink(PATHS.hologramPort);
      this.proc = null;
      throw new HologramError(
        'Sidecar process exited during startup — check ' +
        path.join(PATHS.hookLogs, 'hologram-sidecar.log'),
      );
    }

    if (!portAppeared) {
      // Sidecar didn't write port file in time — kill it
      try {
        this.proc.kill();
      } catch {
        // Already dead
      }
      safeUnlink(PATHS.hologramPid);
      this.proc = null;
      throw new HologramError(
        `Sidecar did not write port file within ${PORT_POLL_TIMEOUT_MS}ms — check ` +
        path.join(PATHS.hookLogs, 'hologram-sidecar.log'),
      );
    }

    const port = readNumericFile(PATHS.hologramPort);
    log.info('Sidecar started', { pid: this.proc.pid, port });
    // NOTE: No process-exit cleanup registered here. Hooks are ephemeral processes
    // that exit after each invocation. The sidecar is detached and long-lived.
    // Cleaning up PID/port files on hook exit would erase tracking for a live sidecar.
    // Cleanup happens in stop() or via orphan detection on next start().
  }

  /**
   * Stop the sidecar gracefully. Sends SIGTERM, waits grace period, then SIGKILL.
   * Cleans up PID and port files.
   */
  async stop(): Promise<void> {
    const pid = readNumericFile(PATHS.hologramPid);

    if (pid === null) {
      log.info('No PID file — sidecar not running');
      this.proc = null;
      return;
    }

    if (!isProcessAlive(pid)) {
      log.info('Sidecar process already dead, cleaning up files');
      safeUnlink(PATHS.hologramPid);
      safeUnlink(PATHS.hologramPort);
      this.proc = null;
      return;
    }

    log.info('Stopping sidecar', { pid });

    // Send SIGTERM (on Windows this calls TerminateProcess via proc.kill())
    try {
      process.kill(pid);
    } catch {
      // Already dead
    }

    // Wait for process to exit
    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Force kill if still alive
    if (isProcessAlive(pid)) {
      log.warn('Sidecar did not exit gracefully, sending SIGKILL', { pid });
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }
    }

    safeUnlink(PATHS.hologramPid);
    safeUnlink(PATHS.hologramPort);
    this.proc = null;

    log.info('Sidecar stopped');
  }

  /**
   * Check if the sidecar is currently running.
   * Verifies both PID alive and port file existence.
   */
  isRunning(): boolean {
    const pid = readNumericFile(PATHS.hologramPid);
    if (pid === null) return false;
    if (!isProcessAlive(pid)) return false;
    return fs.existsSync(PATHS.hologramPort);
  }

  /**
   * Get the TCP port the sidecar is listening on.
   * Returns null if port file missing/invalid.
   * Does NOT require PID file — supports adopted sidecars (port file only).
   */
  getPort(): number | null {
    return readNumericFile(PATHS.hologramPort);
  }

  /**
   * Restart the sidecar: stop then start.
   */
  async restart(): Promise<void> {
    log.info('Restarting sidecar');
    await this.stop();
    await this.start();
  }
}
