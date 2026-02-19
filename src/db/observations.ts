/**
 * Claudex v2 — Observation CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { Observation } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { safeJsonParse } from '../shared/safe-json.js';
import { ensureEpochMs } from '../shared/epoch.js';

const log = createLogger('observations');

/**
 * Store a new observation in the database.
 * Returns the inserted row id, or { id: -1 } on error.
 */
export function storeObservation(db: Database.Database, obs: Observation): { id: number } {
  const startMs = Date.now();
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    const stmt = db.prepare(`
      INSERT INTO observations (
        session_id, project, timestamp, timestamp_epoch,
        tool_name, category, title, content,
        facts, files_read, files_modified,
        importance, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      obs.session_id,
      obs.project ?? null,
      obs.timestamp,
      ensureEpochMs(obs.timestamp_epoch),
      obs.tool_name,
      obs.category,
      obs.title,
      obs.content,
      obs.facts ? JSON.stringify(obs.facts) : null,
      obs.files_read ? JSON.stringify(obs.files_read) : null,
      obs.files_modified ? JSON.stringify(obs.files_modified) : null,
      obs.importance,
      now,
      nowEpoch,
    );

    recordMetric('db.insert', Date.now() - startMs);
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    recordMetric('db.insert', Date.now() - startMs, true);
    log.error('Failed to store observation:', err);
    return { id: -1 };
  }
}

/** Row shape returned by SQLite before hydration */
interface ObservationRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  tool_name: string;
  category: string;
  title: string;
  content: string | null;
  facts: string | null;
  files_read: string | null;
  files_modified: string | null;
  importance: number;
}

function rowToObservation(row: ObservationRow): Observation {
  return {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    tool_name: row.tool_name,
    category: row.category as Observation['category'],
    title: row.title,
    content: row.content ?? '',
    facts: row.facts ? safeJsonParse<string[]>(row.facts, []) : undefined,
    files_read: row.files_read ? safeJsonParse<string[]>(row.files_read, []) : undefined,
    files_modified: row.files_modified ? safeJsonParse<string[]>(row.files_modified, []) : undefined,
    importance: row.importance,
  };
}

/**
 * Get all observations for a given session, ordered by timestamp ascending.
 */
export function getObservationsBySession(db: Database.Database, sessionId: string): Observation[] {
  const startMs = Date.now();
  try {
    const rows = db.prepare(`
      SELECT id, session_id, project, timestamp, timestamp_epoch,
             tool_name, category, title, content,
             facts, files_read, files_modified, importance
      FROM observations
      WHERE session_id = ?
      ORDER BY timestamp_epoch ASC
    `).all(sessionId) as ObservationRow[];

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToObservation);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get observations by session:', err);
    return [];
  }
}

/**
 * Get the most recent observations, optionally filtered by project.
 *
 * @param project - undefined: all records, string: specific project, null: global-scope only (WHERE project IS NULL)
 */
export function getRecentObservations(db: Database.Database, limit: number, project?: string | null): Observation[] {
  const startMs = Date.now();
  try {
    let sql: string;
    let rows: ObservationRow[];

    if (project === null) {
      // Global scope: only records with project IS NULL
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             WHERE project IS NULL
             ORDER BY timestamp_epoch DESC
             LIMIT ?`;
      rows = db.prepare(sql).all(limit) as ObservationRow[];
    } else if (project !== undefined) {
      // Specific project
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             WHERE project = ?
             ORDER BY timestamp_epoch DESC
             LIMIT ?`;
      rows = db.prepare(sql).all(project, limit) as ObservationRow[];
    } else {
      // All records (no filter)
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             ORDER BY timestamp_epoch DESC
             LIMIT ?`;
      rows = db.prepare(sql).all(limit) as ObservationRow[];
    }

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToObservation);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get recent observations:', err);
    return [];
  }
}

/**
 * Get observations since a given epoch, optionally filtered by project.
 *
 * @param epochMs - Only return observations with timestamp_epoch > this value (milliseconds)
 * @param project - undefined: all records, string: specific project, null: global-scope only (WHERE project IS NULL)
 */
export function getObservationsSince(db: Database.Database, epochMs: number, project?: string | null): Observation[] {
  const startMs = Date.now();
  try {
    let sql: string;
    let rows: ObservationRow[];

    if (project === null) {
      // Global scope: only records with project IS NULL
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             WHERE timestamp_epoch > ? AND project IS NULL
             ORDER BY timestamp_epoch DESC
             LIMIT 50`;
      rows = db.prepare(sql).all(ensureEpochMs(epochMs)) as ObservationRow[];
    } else if (project !== undefined) {
      // Specific project
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             WHERE timestamp_epoch > ? AND project = ?
             ORDER BY timestamp_epoch DESC
             LIMIT 50`;
      rows = db.prepare(sql).all(ensureEpochMs(epochMs), project) as ObservationRow[];
    } else {
      // All records (no project filter)
      sql = `SELECT id, session_id, project, timestamp, timestamp_epoch,
                    tool_name, category, title, content,
                    facts, files_read, files_modified, importance
             FROM observations
             WHERE timestamp_epoch > ?
             ORDER BY timestamp_epoch DESC
             LIMIT 50`;
      rows = db.prepare(sql).all(ensureEpochMs(epochMs)) as ObservationRow[];
    }

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToObservation);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get observations since epoch:', err);
    return [];
  }
}

/**
 * Delete observations older than the given epoch timestamp.
 * Returns the number of deleted rows, or 0 on error.
 */
export function deleteOldObservations(db: Database.Database, olderThanEpoch: number): number {
  const startMs = Date.now();
  try {
    const result = db.prepare(
      'DELETE FROM observations WHERE timestamp_epoch < ?'
    ).run(ensureEpochMs(olderThanEpoch));

    recordMetric('db.query', Date.now() - startMs);
    return result.changes;
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to delete old observations:', err);
    return 0;
  }
}
