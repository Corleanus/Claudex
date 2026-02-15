/**
 * Claudex v2 — Session CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { SessionRecord } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('sessions');

/**
 * Create a new session record.
 * Returns the inserted row id, or { id: -1 } on error.
 */
export function createSession(
  db: Database.Database,
  session: { session_id: string; scope: string; project?: string; cwd: string },
): { id: number } {
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    const result = db.prepare(`
      INSERT INTO sessions (session_id, scope, project, cwd, started_at, started_at_epoch, status, observation_count)
      VALUES (?, ?, ?, ?, ?, ?, 'active', 0)
    `).run(
      session.session_id,
      session.scope,
      session.project ?? null,
      session.cwd,
      now,
      nowEpoch,
    );

    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    log.error('Failed to create session:', err);
    return { id: -1 };
  }
}

/**
 * Update a session's status and optionally set ended_at timestamp.
 */
export function updateSessionStatus(
  db: Database.Database,
  sessionId: string,
  status: string,
  endedAt?: string,
): void {
  try {
    if (endedAt) {
      const endedAtEpoch = new Date(endedAt).getTime();
      db.prepare(`
        UPDATE sessions SET status = ?, ended_at = ?, ended_at_epoch = ?
        WHERE session_id = ?
      `).run(status, endedAt, endedAtEpoch, sessionId);
    } else {
      db.prepare(`
        UPDATE sessions SET status = ?
        WHERE session_id = ?
      `).run(status, sessionId);
    }
  } catch (err) {
    log.error('Failed to update session status:', err);
  }
}

/**
 * Get the currently active session, or null if none exists.
 */
export function getActiveSession(db: Database.Database): SessionRecord | null {
  try {
    const row = db.prepare(`
      SELECT id, session_id, scope, project, cwd,
             started_at, started_at_epoch, ended_at, ended_at_epoch,
             status, observation_count
      FROM sessions
      WHERE status = 'active'
      ORDER BY started_at_epoch DESC
      LIMIT 1
    `).get() as SessionRow | undefined;

    if (!row) return null;

    return {
      id: row.id,
      session_id: row.session_id,
      scope: row.scope,
      project: row.project ?? undefined,
      cwd: row.cwd,
      started_at: row.started_at,
      started_at_epoch: row.started_at_epoch,
      ended_at: row.ended_at ?? undefined,
      ended_at_epoch: row.ended_at_epoch ?? undefined,
      status: row.status as SessionRecord['status'],
      observation_count: row.observation_count,
    };
  } catch (err) {
    log.error('Failed to get active session:', err);
    return null;
  }
}

/**
 * Increment the observation_count for a session.
 */
export function incrementObservationCount(db: Database.Database, sessionId: string): void {
  try {
    db.prepare(`
      UPDATE sessions SET observation_count = observation_count + 1
      WHERE session_id = ?
    `).run(sessionId);
  } catch (err) {
    log.error('Failed to increment observation count:', err);
  }
}

/** Row shape returned by SQLite before hydration */
interface SessionRow {
  id: number;
  session_id: string;
  scope: string;
  project: string | null;
  cwd: string;
  started_at: string;
  started_at_epoch: number;
  ended_at: string | null;
  ended_at_epoch: number | null;
  status: string;
  observation_count: number;
}
