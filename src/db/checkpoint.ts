/**
 * Claudex v2 — Checkpoint State CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { CheckpointState } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { safeJsonParse } from '../shared/safe-json.js';

const log = createLogger('checkpoint');

/** Row shape returned by SQLite before hydration */
interface CheckpointRow {
  session_id: string;
  last_epoch: number;
  active_files: string | null;
  boost_applied_at: number | null;
  boost_turn_count: number | null;
}

function rowToCheckpointState(row: CheckpointRow): CheckpointState {
  return {
    session_id: row.session_id,
    last_epoch: row.last_epoch,
    active_files: (() => {
      const parsed = safeJsonParse<unknown>(row.active_files ?? '', []);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    })(),
    boost_applied_at: row.boost_applied_at ?? undefined,
    boost_turn_count: row.boost_turn_count ?? undefined,
  };
}

/**
 * Get checkpoint state for a session.
 * Returns null if no checkpoint exists for the session.
 */
export function getCheckpointState(db: Database.Database, sessionId: string): CheckpointState | null {
  const startMs = Date.now();
  try {
    const row = db.prepare(`
      SELECT session_id, last_epoch, active_files, boost_applied_at, boost_turn_count
      FROM checkpoint_state
      WHERE session_id = ?
    `).get(sessionId) as CheckpointRow | undefined;

    recordMetric('db.query', Date.now() - startMs);
    return row ? rowToCheckpointState(row) : null;
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get checkpoint state:', err);
    return null;
  }
}

/**
 * Upsert checkpoint state for a session.
 * Serializes activeFiles as JSON. Returns true on success, false on error.
 */
export function upsertCheckpointState(
  db: Database.Database,
  sessionId: string,
  lastEpoch: number,
  activeFiles: string[],
): boolean {
  const startMs = Date.now();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO checkpoint_state (session_id, last_epoch, active_files)
      VALUES (?, ?, ?)
    `).run(sessionId, lastEpoch, JSON.stringify(activeFiles));

    recordMetric('db.insert', Date.now() - startMs);
    return true;
  } catch (err) {
    recordMetric('db.insert', Date.now() - startMs, true);
    log.error('Failed to upsert checkpoint state:', err);
    return false;
  }
}

/**
 * Update boost state for a session's checkpoint.
 * Returns true on success, false on error (including no row to update).
 */
export function updateBoostState(
  db: Database.Database,
  sessionId: string,
  boostAppliedAt: number,
  boostTurnCount: number,
): boolean {
  const startMs = Date.now();
  try {
    const result = db.prepare(`
      UPDATE checkpoint_state
      SET boost_applied_at = ?, boost_turn_count = ?
      WHERE session_id = ?
    `).run(boostAppliedAt, boostTurnCount, sessionId);

    recordMetric('db.query', Date.now() - startMs);
    return result.changes > 0;
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to update boost state:', err);
    return false;
  }
}
