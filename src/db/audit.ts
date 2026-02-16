/**
 * Claudex v2 — Audit Log CRUD (Module 8.3)
 *
 * Best-effort audit logging. logAudit() NEVER throws — audit failure
 * must not break hook execution. Details are redacted via redactSensitive()
 * and capped at 2000 chars before storage.
 */

import type Database from 'better-sqlite3';
import { redactSensitive } from '../lib/redaction.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('audit');

const MAX_DETAILS_LENGTH = 2000;

// =============================================================================
// Types
// =============================================================================

export type AuditEventType =
  | 'search'
  | 'context_assembly'
  | 'retention_cleanup'
  | 'observation_store'
  | 'pressure_update';

export interface AuditEntry {
  id?: number;
  timestamp: string;
  timestamp_epoch: number;
  session_id?: string | null;
  event_type: AuditEventType;
  actor: string;
  details?: Record<string, unknown>;
  created_at?: string;
}

// =============================================================================
// Write
// =============================================================================

/**
 * Log an audit entry. Never throws — audit is best-effort.
 * Details are redacted and capped at 2000 chars.
 */
export function logAudit(
  db: Database.Database,
  entry: Omit<AuditEntry, 'id' | 'created_at'>,
): void {
  try {
    const now = new Date().toISOString();

    // Serialize and redact details — ensure valid JSON after truncation
    let detailsStr: string | null = null;
    if (entry.details) {
      let raw = JSON.stringify(entry.details);
      raw = redactSensitive(raw);
      if (raw.length > MAX_DETAILS_LENGTH) {
        // Don't slice raw JSON (produces invalid JSON). Store a safe truncated version.
        raw = JSON.stringify({ _truncated: true, _preview: raw.slice(0, MAX_DETAILS_LENGTH - 100) });
      }
      detailsStr = raw;
    }

    db.prepare(`
      INSERT INTO audit_log (timestamp, timestamp_epoch, session_id, event_type, actor, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.timestamp_epoch,
      entry.session_id ?? null,
      entry.event_type,
      entry.actor,
      detailsStr,
      now,
    );
  } catch (err) {
    // Never crash — audit is best-effort
    log.error('Failed to write audit log entry:', err);
  }
}

// =============================================================================
// Read
// =============================================================================

/**
 * Query audit log with optional filters. Never throws — returns empty on error.
 */
export function getAuditLog(
  db: Database.Database,
  options?: {
    sessionId?: string;
    eventType?: string;
    limit?: number;
  },
): AuditEntry[] {
  try {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (options?.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (options?.eventType) {
      sql += ' AND event_type = ?';
      params.push(options.eventType);
    }

    sql += ' ORDER BY timestamp_epoch DESC';

    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }

    const rows = db.prepare(sql).all(...params) as Array<{
      id: number;
      timestamp: string;
      timestamp_epoch: number;
      session_id: string | null;
      event_type: string;
      actor: string;
      details: string | null;
      created_at: string;
    }>;

    return rows.map(row => {
      let details: Record<string, unknown> | undefined;
      if (row.details) {
        try { details = JSON.parse(row.details); } catch { details = { _raw: row.details }; }
      }
      return {
        id: row.id,
        timestamp: row.timestamp,
        timestamp_epoch: row.timestamp_epoch,
        session_id: row.session_id,
        event_type: row.event_type as AuditEventType,
        actor: row.actor,
        details,
        created_at: row.created_at,
      };
    });
  } catch (err) {
    log.error('Failed to read audit log:', err);
    return [];
  }
}

// =============================================================================
// Cleanup
// =============================================================================

/**
 * Delete audit log entries older than retentionDays. Never throws.
 * Returns the number of deleted rows.
 */
export function cleanOldAuditLogs(
  db: Database.Database,
  retentionDays = 30,
): number {
  try {
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    return db.prepare('DELETE FROM audit_log WHERE timestamp_epoch < ?').run(cutoff).changes;
  } catch (err) {
    log.error('Failed to clean old audit logs:', err);
    return 0;
  }
}
