/**
 * Claudex v2 — Observation CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { Observation } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('observations');

/**
 * Store a new observation in the database.
 * Returns the inserted row id, or { id: -1 } on error.
 */
export function storeObservation(db: Database.Database, obs: Observation): { id: number } {
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
      obs.timestamp_epoch,
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

    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
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
    facts: row.facts ? JSON.parse(row.facts) : undefined,
    files_read: row.files_read ? JSON.parse(row.files_read) : undefined,
    files_modified: row.files_modified ? JSON.parse(row.files_modified) : undefined,
    importance: row.importance,
  };
}

/**
 * Get all observations for a given session, ordered by timestamp ascending.
 */
export function getObservationsBySession(db: Database.Database, sessionId: string): Observation[] {
  try {
    const rows = db.prepare(`
      SELECT id, session_id, project, timestamp, timestamp_epoch,
             tool_name, category, title, content,
             facts, files_read, files_modified, importance
      FROM observations
      WHERE session_id = ?
      ORDER BY timestamp_epoch ASC
    `).all(sessionId) as ObservationRow[];

    return rows.map(rowToObservation);
  } catch (err) {
    log.error('Failed to get observations by session:', err);
    return [];
  }
}

/**
 * Get the most recent observations, optionally filtered by project.
 */
export function getRecentObservations(db: Database.Database, limit: number, project?: string): Observation[] {
  try {
    const sql = project
      ? `SELECT id, session_id, project, timestamp, timestamp_epoch,
                tool_name, category, title, content,
                facts, files_read, files_modified, importance
         FROM observations
         WHERE project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      : `SELECT id, session_id, project, timestamp, timestamp_epoch,
                tool_name, category, title, content,
                facts, files_read, files_modified, importance
         FROM observations
         ORDER BY timestamp_epoch DESC
         LIMIT ?`;

    const rows = project
      ? db.prepare(sql).all(project, limit) as ObservationRow[]
      : db.prepare(sql).all(limit) as ObservationRow[];

    return rows.map(rowToObservation);
  } catch (err) {
    log.error('Failed to get recent observations:', err);
    return [];
  }
}

/**
 * Delete observations older than the given epoch timestamp.
 * Returns the number of deleted rows, or 0 on error.
 */
export function deleteOldObservations(db: Database.Database, olderThanEpoch: number): number {
  try {
    const result = db.prepare(
      'DELETE FROM observations WHERE timestamp_epoch < ?'
    ).run(olderThanEpoch);

    return result.changes;
  } catch (err) {
    log.error('Failed to delete old observations:', err);
    return 0;
  }
}
