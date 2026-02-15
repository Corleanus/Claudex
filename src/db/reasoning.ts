/**
 * Claudex v2 — Reasoning Chain CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { ReasoningChain, ReasoningTrigger } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('reasoning');

/** Row shape returned by SQLite before hydration */
interface ReasoningRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  trigger: string;
  title: string;
  reasoning: string;
  decisions: string | null;
  files_involved: string | null;
  importance: number;
  created_at: string;
  created_at_epoch: number;
}

function rowToReasoningChain(row: ReasoningRow): ReasoningChain {
  return {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    trigger: row.trigger as ReasoningTrigger,
    title: row.title,
    reasoning: row.reasoning,
    decisions: row.decisions ? JSON.parse(row.decisions) : undefined,
    files_involved: row.files_involved ? JSON.parse(row.files_involved) : undefined,
    importance: row.importance,
    created_at: row.created_at,
    created_at_epoch: row.created_at_epoch,
  };
}

/**
 * Insert a new reasoning chain.
 * Returns the inserted row id, or { id: -1 } on error.
 */
export function insertReasoning(
  db: Database.Database,
  chain: Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'>,
): { id: number } {
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    const stmt = db.prepare(`
      INSERT INTO reasoning_chains (
        session_id, project, timestamp, timestamp_epoch,
        trigger, title, reasoning,
        decisions, files_involved,
        importance, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      chain.session_id,
      chain.project ?? null,
      chain.timestamp,
      chain.timestamp_epoch,
      chain.trigger,
      chain.title,
      chain.reasoning,
      chain.decisions ? JSON.stringify(chain.decisions) : null,
      chain.files_involved ? JSON.stringify(chain.files_involved) : null,
      chain.importance,
      now,
      nowEpoch,
    );

    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    log.error('Failed to insert reasoning chain:', err);
    return { id: -1 };
  }
}

/**
 * Get all reasoning chains for a session, ordered by timestamp ascending.
 */
export function getReasoningBySession(db: Database.Database, sessionId: string): ReasoningChain[] {
  try {
    const rows = db.prepare(`
      SELECT id, session_id, project, timestamp, timestamp_epoch,
             trigger, title, reasoning,
             decisions, files_involved,
             importance, created_at, created_at_epoch
      FROM reasoning_chains
      WHERE session_id = ?
      ORDER BY timestamp_epoch ASC
    `).all(sessionId) as ReasoningRow[];

    return rows.map(rowToReasoningChain);
  } catch (err) {
    log.error('Failed to get reasoning by session:', err);
    return [];
  }
}

/**
 * Get the most recent reasoning chains, optionally filtered by project.
 * Ordered by timestamp_epoch DESC.
 */
export function getRecentReasoning(db: Database.Database, limit: number, project?: string): ReasoningChain[] {
  try {
    const sql = project
      ? `SELECT id, session_id, project, timestamp, timestamp_epoch,
                trigger, title, reasoning,
                decisions, files_involved,
                importance, created_at, created_at_epoch
         FROM reasoning_chains
         WHERE project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      : `SELECT id, session_id, project, timestamp, timestamp_epoch,
                trigger, title, reasoning,
                decisions, files_involved,
                importance, created_at, created_at_epoch
         FROM reasoning_chains
         ORDER BY timestamp_epoch DESC
         LIMIT ?`;

    const rows = project
      ? db.prepare(sql).all(project, limit) as ReasoningRow[]
      : db.prepare(sql).all(limit) as ReasoningRow[];

    return rows.map(rowToReasoningChain);
  } catch (err) {
    log.error('Failed to get recent reasoning:', err);
    return [];
  }
}

/**
 * Simple LIKE search across title and reasoning columns.
 * Returns empty on error or empty query. This is a basic fallback;
 * FTS5 search will be added by the Search Agent.
 */
export function searchReasoning(
  db: Database.Database,
  query: string,
  options?: { project?: string; limit?: number },
): ReasoningChain[] {
  try {
    if (!query || query.trim().length === 0) {
      return [];
    }

    const searchTerm = `%${query}%`;
    const limit = options?.limit ?? 50;

    const sql = options?.project
      ? `SELECT id, session_id, project, timestamp, timestamp_epoch,
                trigger, title, reasoning,
                decisions, files_involved,
                importance, created_at, created_at_epoch
         FROM reasoning_chains
         WHERE (title LIKE ? OR reasoning LIKE ?)
           AND project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      : `SELECT id, session_id, project, timestamp, timestamp_epoch,
                trigger, title, reasoning,
                decisions, files_involved,
                importance, created_at, created_at_epoch
         FROM reasoning_chains
         WHERE title LIKE ? OR reasoning LIKE ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`;

    const rows = options?.project
      ? db.prepare(sql).all(searchTerm, searchTerm, options.project, limit) as ReasoningRow[]
      : db.prepare(sql).all(searchTerm, searchTerm, limit) as ReasoningRow[];

    return rows.map(rowToReasoningChain);
  } catch (err) {
    log.error('Failed to search reasoning:', err);
    return [];
  }
}
