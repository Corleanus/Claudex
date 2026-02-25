/**
 * Claudex v2 — Wave 3 Schema: Decay & Selection Pressure Engine
 *
 * Migration 7: Adds access tracking to observations and decay epoch to pressure_scores.
 * - observations.access_count: number of times retrieved
 * - observations.last_accessed_at_epoch: last access timestamp (ms)
 * - observations.deleted_at_epoch: soft-delete marker
 * - pressure_scores.last_decay_epoch: idempotency guard for stratified decay
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('schema-wave3');

export function migration_7(runner: MigrationRunner): void {
  if (runner.hasVersion(7)) {
    log.debug('Migration 7 already applied, skipping');
    return;
  }

  log.info('Applying migration 7: decay engine columns');

  // SQLite ALTER TABLE only supports one ADD COLUMN per statement
  runner.db.exec(`ALTER TABLE observations ADD COLUMN access_count INTEGER DEFAULT 0`);
  runner.db.exec(`ALTER TABLE observations ADD COLUMN last_accessed_at_epoch INTEGER`);
  runner.db.exec(`ALTER TABLE observations ADD COLUMN deleted_at_epoch INTEGER`);
  runner.db.exec(`ALTER TABLE pressure_scores ADD COLUMN last_decay_epoch INTEGER`);

  // Indexes for new columns used in hot-path queries
  runner.db.exec(`CREATE INDEX IF NOT EXISTS idx_observations_deleted_at ON observations(deleted_at_epoch)`);
  runner.db.exec(`CREATE INDEX IF NOT EXISTS idx_pressure_last_decay ON pressure_scores(last_decay_epoch)`);

  runner.recordVersion(7);
  log.info('Migration 7 applied successfully');
}
