/**
 * Claudex v2 — Database Connection Factory
 *
 * Opens a better-sqlite3 connection with WAL mode and performance PRAGMAs.
 * Runs migrations on every open. Connection is opened ONCE per hook
 * invocation and closed before exit.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { PATHS } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import { MigrationRunner } from './migrations.js';
import { loadConfig } from '../shared/config.js';

const log = createLogger('database');

/**
 * Open and configure a SQLite database connection.
 *
 * - Creates the database directory if missing
 * - Applies WAL mode and performance PRAGMAs
 * - Runs all migrations
 *
 * @param dbPath - Path to the database file. Defaults to PATHS.database (~/.claudex/db/claudex.db)
 * @returns Configured Database instance, or null on failure
 */
export function getDatabase(dbPath?: string): Database.Database | null {
  const resolvedPath = dbPath ?? PATHS.database;
  let db: Database.Database | undefined;

  try {
    // Ensure parent directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      log.info('Created database directory:', dir);
    }

    db = new Database(resolvedPath);

    // Apply PRAGMAs
    const config = loadConfig();
    if (config.database?.wal_mode !== false) {
      db.pragma('journal_mode = WAL');
    }
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = memory');
    db.pragma('cache_size = 10000');

    log.debug('Database opened with PRAGMAs applied:', resolvedPath);

    // Run migrations
    const runner = new MigrationRunner(db);
    runner.run();

    log.info('Database ready:', resolvedPath);
    return db;
  } catch (err) {
    log.error(`Failed to open database at ${resolvedPath}:`, err);
    if (db) {
      try {
        db.close();
      } catch (closeErr) {
        log.error('Failed to close database handle after error:', closeErr);
      }
    }
    return null;
  }
}
