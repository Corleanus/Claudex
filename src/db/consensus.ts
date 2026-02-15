/**
 * Claudex v2 — Consensus Decision CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { ConsensusDecision, ConsensusStatus } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('consensus');

const validStatuses: readonly ConsensusStatus[] = ['proposed', 'agreed', 'rejected', 'superseded'] as const;

/** Row shape returned by SQLite before hydration */
interface ConsensusRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  title: string;
  description: string;
  claude_position: string | null;
  codex_position: string | null;
  human_verdict: string | null;
  status: string;
  tags: string | null;
  files_affected: string | null;
  importance: number;
  created_at: string;
  created_at_epoch: number;
}

function rowToConsensusDecision(row: ConsensusRow): ConsensusDecision {
  return {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    title: row.title,
    description: row.description,
    claude_position: row.claude_position ?? undefined,
    codex_position: row.codex_position ?? undefined,
    human_verdict: row.human_verdict ?? undefined,
    status: row.status as ConsensusStatus,
    tags: row.tags ? JSON.parse(row.tags) : undefined,
    files_affected: row.files_affected ? JSON.parse(row.files_affected) : undefined,
    importance: row.importance,
    created_at: row.created_at,
    created_at_epoch: row.created_at_epoch,
  };
}

/**
 * Insert a new consensus decision.
 * Returns the inserted row id, or { id: -1 } on error.
 */
export function insertConsensus(
  db: Database.Database,
  decision: Omit<ConsensusDecision, 'id' | 'created_at' | 'created_at_epoch'>,
): { id: number } {
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    const stmt = db.prepare(`
      INSERT INTO consensus_decisions (
        session_id, project, timestamp, timestamp_epoch,
        title, description,
        claude_position, codex_position, human_verdict,
        status, tags, files_affected,
        importance, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      decision.session_id,
      decision.project ?? null,
      decision.timestamp,
      decision.timestamp_epoch,
      decision.title,
      decision.description,
      decision.claude_position ?? null,
      decision.codex_position ?? null,
      decision.human_verdict ?? null,
      decision.status,
      decision.tags ? JSON.stringify(decision.tags) : null,
      decision.files_affected ? JSON.stringify(decision.files_affected) : null,
      decision.importance,
      now,
      nowEpoch,
    );

    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    log.error('Failed to insert consensus decision:', err);
    return { id: -1 };
  }
}

/**
 * Update the status of an existing consensus decision.
 * Validates status against ConsensusStatus type. Returns silently on error.
 */
export function updateConsensusStatus(db: Database.Database, id: number, status: ConsensusStatus): void {
  try {
    if (!validStatuses.includes(status)) {
      log.warn(`Invalid consensus status: ${status}`);
      return;
    }

    db.prepare(`
      UPDATE consensus_decisions SET status = ?
      WHERE id = ?
    `).run(status, id);
  } catch (err) {
    log.error('Failed to update consensus status:', err);
  }
}

/**
 * Get all consensus decisions for a session, ordered by timestamp ascending.
 */
export function getConsensusBySession(db: Database.Database, sessionId: string): ConsensusDecision[] {
  try {
    const rows = db.prepare(`
      SELECT id, session_id, project, timestamp, timestamp_epoch,
             title, description,
             claude_position, codex_position, human_verdict,
             status, tags, files_affected,
             importance, created_at, created_at_epoch
      FROM consensus_decisions
      WHERE session_id = ?
      ORDER BY timestamp_epoch ASC
    `).all(sessionId) as ConsensusRow[];

    return rows.map(rowToConsensusDecision);
  } catch (err) {
    log.error('Failed to get consensus by session:', err);
    return [];
  }
}

/**
 * Get the most recent consensus decisions, optionally filtered by project.
 * Ordered by timestamp_epoch DESC.
 */
export function getRecentConsensus(db: Database.Database, limit: number, project?: string): ConsensusDecision[] {
  try {
    const sql = project
      ? `SELECT id, session_id, project, timestamp, timestamp_epoch,
                title, description,
                claude_position, codex_position, human_verdict,
                status, tags, files_affected,
                importance, created_at, created_at_epoch
         FROM consensus_decisions
         WHERE project = ?
         ORDER BY timestamp_epoch DESC
         LIMIT ?`
      : `SELECT id, session_id, project, timestamp, timestamp_epoch,
                title, description,
                claude_position, codex_position, human_verdict,
                status, tags, files_affected,
                importance, created_at, created_at_epoch
         FROM consensus_decisions
         ORDER BY timestamp_epoch DESC
         LIMIT ?`;

    const rows = project
      ? db.prepare(sql).all(project, limit) as ConsensusRow[]
      : db.prepare(sql).all(limit) as ConsensusRow[];

    return rows.map(rowToConsensusDecision);
  } catch (err) {
    log.error('Failed to get recent consensus:', err);
    return [];
  }
}
