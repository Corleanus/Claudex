/**
 * Claudex v2 — Migration Runner
 *
 * Sequential, idempotent migration system using schema_versions table.
 * Each migration checks if already applied before running.
 * Adapted from claude-mem MigrationRunner pattern.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { migration_1 } from './schema.js';
import { migration_2 } from './search.js';
import { migration_3 } from './schema-phase2.js';

const log = createLogger('migrations');

export class MigrationRunner {
  constructor(readonly db: Database.Database) {}

  /**
   * Run all migrations in order. Safe to call multiple times —
   * each migration checks schema_versions before applying.
   */
  run(): void {
    this.ensureSchemaVersionsTable();
    migration_1(this);
    migration_2(this);
    migration_3(this);
    // Future migrations added here in sequence
  }

  /**
   * Create the schema_versions table if it doesn't exist.
   * This is the foundation — must exist before any migration can check/record versions.
   */
  private ensureSchemaVersionsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    log.debug('schema_versions table ensured');
  }

  /**
   * Check if a migration version has already been applied.
   */
  hasVersion(version: number): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM schema_versions WHERE version = ?')
      .get(version);
    return !!row;
  }

  /**
   * Record that a migration version has been applied.
   */
  recordVersion(version: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)',
      )
      .run(version, new Date().toISOString());
  }
}
