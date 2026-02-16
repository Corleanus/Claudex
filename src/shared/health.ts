/** Claudex v2 — System Health Check */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MetricEntry } from './metrics.js';
import type { ClaudexConfig } from './types.js';
import type { RecoveryReport } from '../lib/recovery.js';
import { PATHS, CLAUDEX_HOME } from './paths.js';
import { getMetrics } from './metrics.js';
import { createLogger } from './logger.js';

const log = createLogger('health');

// =============================================================================
// Types
// =============================================================================

export interface HealthReport {
  database: { ok: boolean; observationCount: number; sessionCount: number };
  hologram: { ok: boolean; port: number | null };
  wrapper: { enabled: boolean; lastFlushEpoch: number };
  metrics: Record<string, MetricEntry>;
  recovery?: RecoveryReport;
}

// =============================================================================
// Constants
// =============================================================================

/** File-based cooldown marker — same path as flush-trigger.ts */
const COOLDOWN_FILE = path.join(CLAUDEX_HOME, 'db', '.flush_cooldown');

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Check database health by querying row counts.
 * If a db is provided, uses it directly (caller manages lifecycle).
 * Otherwise, opens a connection via getDatabase() and closes after.
 * Never throws — returns ok:false with zero counts on any failure.
 */
async function checkDatabase(db?: import('better-sqlite3').Database | null): Promise<HealthReport['database']> {
  try {
    let ownedDb = false;
    let conn: import('better-sqlite3').Database | undefined | null = db;

    if (!conn) {
      // Dynamic import to avoid hard dependency at module load time
      const { getDatabase } = await import('../db/connection.js');
      conn = getDatabase();
      ownedDb = true;
    }

    // conn could still be null if getDatabase() returned null
    if (!conn) {
      log.warn('Database connection is null');
      return { ok: false, observationCount: 0, sessionCount: 0 };
    }

    try {
      const obsRow = conn.prepare('SELECT COUNT(*) as c FROM observations').get() as
        | { c: number }
        | undefined;
      const sessRow = conn.prepare('SELECT COUNT(*) as c FROM sessions').get() as
        | { c: number }
        | undefined;

      return {
        ok: true,
        observationCount: obsRow?.c ?? 0,
        sessionCount: sessRow?.c ?? 0,
      };
    } finally {
      if (ownedDb) {
        try {
          conn.close();
        } catch {
          // Close failure is non-fatal
        }
      }
    }
  } catch (err) {
    log.warn('Database health check failed:', err);
    return { ok: false, observationCount: 0, sessionCount: 0 };
  }
}

/**
 * Check hologram sidecar health by reading the port file.
 * Never throws.
 */
function checkHologram(config: ClaudexConfig): HealthReport['hologram'] {
  try {
    const enabled = config.hologram?.enabled ?? false;
    let port: number | null = null;
    let portFileExists = false;

    if (fs.existsSync(PATHS.hologramPort)) {
      const content = fs.readFileSync(PATHS.hologramPort, 'utf-8').trim();
      const parsed = Number(content);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
        portFileExists = true;
      }
    }

    return {
      ok: portFileExists && enabled,
      port,
    };
  } catch (err) {
    log.warn('Hologram health check failed:', err);
    return { ok: false, port: null };
  }
}

/**
 * Check wrapper status by reading the cooldown file for last flush epoch.
 * Never throws.
 */
function checkWrapper(config: ClaudexConfig): HealthReport['wrapper'] {
  try {
    const enabled = config.wrapper?.enabled ?? true;
    let lastFlushEpoch = 0;

    if (fs.existsSync(COOLDOWN_FILE)) {
      const content = fs.readFileSync(COOLDOWN_FILE, 'utf-8').trim();
      const parsed = Number(content);
      if (Number.isFinite(parsed)) {
        lastFlushEpoch = parsed;
      }
    }

    return { enabled, lastFlushEpoch };
  } catch (err) {
    log.warn('Wrapper health check failed:', err);
    return { enabled: config.wrapper?.enabled ?? true, lastFlushEpoch: 0 };
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Run a full system health check across database, hologram, wrapper, and metrics.
 * Never throws — each subsystem check is independently wrapped.
 */
export async function checkHealth(config: ClaudexConfig, db?: import('better-sqlite3').Database | null): Promise<HealthReport> {
  return {
    database: await checkDatabase(db),
    hologram: checkHologram(config),
    wrapper: checkWrapper(config),
    metrics: getMetrics(),
  };
}
