import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';

export function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const runner = new MigrationRunner(db);
  runner.run();
  return db;
}
