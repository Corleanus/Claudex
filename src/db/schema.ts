/**
 * Claudex v2 — Database Schema (Migration 1)
 *
 * Defines the observations and sessions tables.
 * Called by the MigrationRunner during database initialization.
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('schema');

/**
 * Migration 1: Create observations and sessions tables with indexes.
 */
export function migration_1(runner: MigrationRunner): void {
  if (runner.hasVersion(1)) {
    log.debug('Migration 1 already applied, skipping');
    return;
  }

  log.info('Applying migration 1: observations + sessions tables');

  runner.db.exec(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      tool_name TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      facts TEXT,
      files_read TEXT,
      files_modified TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );

    CREATE INDEX idx_observations_session_id ON observations(session_id);
    CREATE INDEX idx_observations_project ON observations(project);
    CREATE INDEX idx_observations_category ON observations(category);
    CREATE INDEX idx_observations_timestamp_epoch ON observations(timestamp_epoch DESC);
    CREATE INDEX idx_observations_importance ON observations(importance DESC);

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL,
      project TEXT,
      cwd TEXT NOT NULL,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active',
      observation_count INTEGER DEFAULT 0
    );

    CREATE INDEX idx_sessions_session_id ON sessions(session_id);
    CREATE INDEX idx_sessions_project ON sessions(project);
    CREATE INDEX idx_sessions_status ON sessions(status);
  `);

  runner.recordVersion(1);
  log.info('Migration 1 applied successfully');
}
