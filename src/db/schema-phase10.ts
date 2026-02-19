/**
 * Claudex v2 — Phase 10 Schema: Compact Checkpoints
 *
 * Migration 6: checkpoint_state table for tracking compact checkpoint state.
 * Stores per-session last checkpoint epoch, active files, and boost state.
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('schema-phase10');

export function migration_6(runner: MigrationRunner): void {
  if (runner.hasVersion(6)) {
    log.debug('Migration 6 already applied, skipping');
    return;
  }

  log.info('Applying migration 6: checkpoint_state table');

  runner.db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoint_state (
      session_id TEXT PRIMARY KEY,
      last_epoch INTEGER NOT NULL,
      active_files TEXT,
      boost_applied_at INTEGER,
      boost_turn_count INTEGER DEFAULT 0
    );
  `);

  runner.recordVersion(6);
  log.info('Migration 6 applied successfully');
}
