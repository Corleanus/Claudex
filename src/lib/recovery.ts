/**
 * Claudex v2 — Error Recovery & Self-Healing
 *
 * Detects and recovers from common failure modes:
 * - Database corruption
 * - Stale sidecar port files
 * - Stale cooldown files
 * - Orphan sessions
 * - Corrupt FTS5 indexes
 *
 * Run on session-start only. All checks are independent — one failure
 * does not block others. Never crashes.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { ClaudexConfig } from '../shared/types.js';
import { PATHS, CLAUDEX_HOME } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('recovery');

// =============================================================================
// Types
// =============================================================================

export interface RecoveryReport {
  checks: RecoveryCheck[];
  actionsPerformed: string[];
  healthy: boolean;
}

export interface RecoveryCheck {
  name: string;
  status: 'ok' | 'warning' | 'recovered' | 'failed';
  message: string;
}

// =============================================================================
// Constants
// =============================================================================

/** File-based cooldown marker — same path as flush-trigger.ts and health.ts */
const COOLDOWN_FILE = path.join(CLAUDEX_HOME, 'db', '.flush_cooldown');

/** Stale thresholds (conservative) */
const STALE_PORT_FILE_MS = 24 * 60 * 60 * 1000;    // 24 hours
const STALE_COOLDOWN_MS = 60 * 60 * 1000;           // 1 hour
const MAX_COOLDOWN_DURATION_MS = 60 * 60 * 1000;    // 1 hour max cooldown duration
const ORPHAN_SESSION_MS = 12 * 60 * 60 * 1000;      // 12 hours
const TCP_PING_TIMEOUT_MS = 1000;                     // 1 second

/** FTS5 tables and their source tables */
const FTS_TABLES: Record<string, string> = {
  observations_fts: 'observations',
  reasoning_fts: 'reasoning_chains',
  consensus_fts: 'consensus_decisions',
};

// =============================================================================
// TCP ping helper
// =============================================================================

/**
 * Test if a TCP port is listening on localhost.
 * Returns true if connection succeeds within timeout, false otherwise.
 */
function pingPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(TCP_PING_TIMEOUT_MS, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// =============================================================================
// Individual checks
// =============================================================================

/**
 * Check 1: Database integrity via PRAGMA integrity_check.
 * Reports only — no auto-fix for DB corruption.
 */
function checkDatabaseIntegrity(db?: Database.Database): RecoveryCheck {
  if (!db) {
    return { name: 'database', status: 'warning', message: 'No database connection' };
  }
  try {
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (result[0]?.integrity_check === 'ok') {
      return { name: 'database', status: 'ok', message: 'Integrity check passed' };
    }
    return {
      name: 'database',
      status: 'failed',
      message: `Integrity check failed: ${result[0]?.integrity_check}`,
    };
  } catch (err) {
    return { name: 'database', status: 'failed', message: `Integrity check error: ${err}` };
  }
}

/**
 * Check 2: Stale sidecar port file (>24h old, sidecar not responding).
 * Uses PATHS.hologramPort — never hardcoded.
 * Pings the port via TCP before deleting to avoid killing a live sidecar.
 */
async function checkStaleSidecar(): Promise<RecoveryCheck> {
  const portFile = PATHS.hologramPort;

  if (!fs.existsSync(portFile)) {
    return { name: 'sidecar_port', status: 'ok', message: 'No port file (sidecar not running)' };
  }

  try {
    const stat = fs.statSync(portFile);
    const ageMs = Date.now() - stat.mtimeMs;

    if (ageMs <= STALE_PORT_FILE_MS) {
      return { name: 'sidecar_port', status: 'ok', message: 'Port file is recent' };
    }

    // Port file is old — ping before deleting
    try {
      const content = fs.readFileSync(portFile, 'utf-8').trim();
      const port = parseInt(content, 10);

      if (Number.isFinite(port) && port > 0) {
        const alive = await pingPort(port);
        if (alive) {
          return {
            name: 'sidecar_port',
            status: 'ok',
            message: `Port file old (${Math.round(ageMs / 3600000)}h) but sidecar still responding`,
          };
        }
      }
    } catch {
      // Ping failed — proceed with cleanup
    }

    fs.unlinkSync(portFile);
    return {
      name: 'sidecar_port',
      status: 'recovered',
      message: `Removed stale port file (${Math.round(ageMs / 3600000)}h old, sidecar not responding)`,
    };
  } catch {
    return { name: 'sidecar_port', status: 'warning', message: 'Could not check port file' };
  }
}

/**
 * Check 3: Stale cooldown file (>1h old).
 * Cooldown prevents rapid re-flushing, but a stale one blocks all flushes.
 * Also validates cooldown timestamps aren't far-future (from bugs/clock skew).
 */
function checkStaleCooldown(): RecoveryCheck {
  if (!fs.existsSync(COOLDOWN_FILE)) {
    return { name: 'cooldown', status: 'ok', message: 'No cooldown file' };
  }

  try {
    const content = fs.readFileSync(COOLDOWN_FILE, 'utf-8').trim();
    const lastFlush = parseInt(content, 10);

    // Validate timestamp is reasonable (not negative, not nonsensical)
    if (!Number.isFinite(lastFlush) || lastFlush < 0) {
      fs.unlinkSync(COOLDOWN_FILE);
      return {
        name: 'cooldown',
        status: 'recovered',
        message: 'Removed cooldown with invalid timestamp',
      };
    }

    const now = Date.now();
    const ageMs = now - lastFlush;

    // If timestamp is far-future (beyond max cooldown duration), reset it
    if (ageMs < -MAX_COOLDOWN_DURATION_MS) {
      fs.unlinkSync(COOLDOWN_FILE);
      return {
        name: 'cooldown',
        status: 'recovered',
        message: `Removed far-future cooldown (${Math.abs(Math.round(ageMs / 60000))}min ahead)`,
      };
    }

    // Normal stale check (past timestamp, older than 1h)
    if (ageMs > STALE_COOLDOWN_MS) {
      fs.unlinkSync(COOLDOWN_FILE);
      return {
        name: 'cooldown',
        status: 'recovered',
        message: `Removed stale cooldown (${Math.round(ageMs / 60000)}min old)`,
      };
    }

    return { name: 'cooldown', status: 'ok', message: 'Cooldown is recent' };
  } catch {
    return { name: 'cooldown', status: 'warning', message: 'Could not check cooldown file' };
  }
}

/**
 * Check 4: Orphan sessions (active >12h).
 * Sets BOTH ended_at (ISO string) AND ended_at_epoch (milliseconds).
 */
function checkOrphanSessions(db: Database.Database): RecoveryCheck {
  try {
    const active = db.prepare(
      "SELECT session_id, started_at_epoch FROM sessions WHERE status = 'active' ORDER BY started_at_epoch DESC",
    ).all() as Array<{ session_id: string; started_at_epoch: number }>;

    if (active.length === 0) {
      return { name: 'orphan_session', status: 'ok', message: 'No orphan sessions' };
    }

    let recovered = 0;
    for (const session of active) {
      if (Date.now() - session.started_at_epoch > ORPHAN_SESSION_MS) {
        const now = new Date().toISOString();
        const nowEpoch = Date.now();
        db.prepare(
          "UPDATE sessions SET status = 'failed', ended_at = ?, ended_at_epoch = ? WHERE session_id = ?",
        ).run(now, nowEpoch, session.session_id);
        recovered++;
      }
    }

    if (recovered > 0) {
      return { name: 'orphan_session', status: 'recovered', message: `Closed ${recovered} orphan session(s)` };
    }

    return { name: 'orphan_session', status: 'ok', message: `${active.length} active session(s) — recent` };
  } catch {
    return { name: 'orphan_session', status: 'warning', message: 'Could not check sessions' };
  }
}

/**
 * Check 5: FTS5 index health.
 * Checks each FTS table independently — older DBs may not have all 3.
 * Attempts rebuild if a table is broken.
 */
function checkFtsHealth(db: Database.Database): RecoveryCheck {
  let healthy = 0;
  let rebuilt = 0;
  let failed = 0;
  const messages: string[] = [];

  for (const [ftsTable] of Object.entries(FTS_TABLES)) {
    try {
      // Check if FTS table exists first (older DBs may not have all tables)
      const exists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
      ).get(ftsTable);

      if (!exists) {
        // Table doesn't exist — skip, don't report as failure
        continue;
      }

      // Try a simple query to verify the FTS table is functional
      db.prepare(`SELECT count(*) as c FROM ${ftsTable} WHERE ${ftsTable} MATCH 'test'`).get();
      healthy++;
    } catch {
      // FTS table exists but is broken — try rebuild
      try {
        db.prepare(`INSERT INTO ${ftsTable}(${ftsTable}) VALUES('rebuild')`).run();
        rebuilt++;
        messages.push(`${ftsTable} rebuilt`);
      } catch {
        failed++;
        messages.push(`${ftsTable} rebuild failed`);
      }
    }
  }

  if (failed > 0) {
    return { name: 'fts5_index', status: 'failed', message: `FTS5: ${messages.join(', ')}` };
  }
  if (rebuilt > 0) {
    return { name: 'fts5_index', status: 'recovered', message: `FTS5: ${messages.join(', ')}` };
  }
  return { name: 'fts5_index', status: 'ok', message: `FTS5: ${healthy} table(s) healthy` };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run all recovery checks. Returns a structured report.
 * All checks are independent — one failure doesn't block others.
 * Never throws.
 */
export async function runRecovery(_config: ClaudexConfig, db?: Database.Database): Promise<RecoveryReport> {
  const checks: RecoveryCheck[] = [];
  const actions: string[] = [];

  // Check 1: Database integrity
  try {
    checks.push(checkDatabaseIntegrity(db));
  } catch (err) {
    log.error('DB integrity check threw unexpectedly:', err);
    checks.push({ name: 'database', status: 'failed', message: `Unexpected error: ${err}` });
  }

  // Check 2: Stale sidecar port file
  try {
    const sidecarCheck = await checkStaleSidecar();
    checks.push(sidecarCheck);
    if (sidecarCheck.status === 'recovered') {
      actions.push('Removed stale sidecar port file');
    }
  } catch (err) {
    log.error('Sidecar check threw unexpectedly:', err);
    checks.push({ name: 'sidecar_port', status: 'warning', message: `Unexpected error: ${err}` });
  }

  // Check 3: Stale cooldown file
  try {
    const cooldownCheck = checkStaleCooldown();
    checks.push(cooldownCheck);
    if (cooldownCheck.status === 'recovered') {
      actions.push('Removed stale cooldown file');
    }
  } catch (err) {
    log.error('Cooldown check threw unexpectedly:', err);
    checks.push({ name: 'cooldown', status: 'warning', message: `Unexpected error: ${err}` });
  }

  // Check 4: Orphan sessions (requires DB)
  if (db) {
    try {
      const sessionCheck = checkOrphanSessions(db);
      checks.push(sessionCheck);
      if (sessionCheck.status === 'recovered') {
        actions.push('Closed orphan active session');
      }
    } catch (err) {
      log.error('Orphan session check threw unexpectedly:', err);
      checks.push({ name: 'orphan_session', status: 'warning', message: `Unexpected error: ${err}` });
    }
  }

  // Check 5: FTS5 health (requires DB)
  if (db) {
    try {
      const ftsCheck = checkFtsHealth(db);
      checks.push(ftsCheck);
      if (ftsCheck.status === 'recovered') {
        actions.push('Rebuilt FTS5 search index');
      }
    } catch (err) {
      log.error('FTS5 check threw unexpectedly:', err);
      checks.push({ name: 'fts5_index', status: 'warning', message: `Unexpected error: ${err}` });
    }
  }

  return {
    checks,
    actionsPerformed: actions,
    healthy: checks.every(c => c.status === 'ok' || c.status === 'recovered'),
  };
}
