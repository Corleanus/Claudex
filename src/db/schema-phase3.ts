/**
 * Claudex v2 — Phase 3 Schema: Audit Logging
 *
 * Migration 5: audit_log table for tracking data access patterns.
 * No FTS5 — queried by event_type + session_id, not full-text searched.
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('schema-phase3');

export function migration_5(runner: MigrationRunner): void {
  if (runner.hasVersion(5)) {
    log.debug('Migration 5 already applied, skipping');
    return;
  }

  log.info('Applying migration 5: audit_log table');

  runner.db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      details TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
  `);

  runner.recordVersion(5);
  log.info('Migration 5 applied successfully');
}
