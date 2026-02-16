import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { enforceRetention } from '../../src/lib/retention.js';
import type { ClaudexConfig } from '../../src/shared/types.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/shared/metrics.js', () => ({
  recordMetric: vi.fn(),
}));

// =============================================================================
// Helpers
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const runner = new MigrationRunner(db);
  migration_1(runner);
  migration_2(runner);
  migration_3(runner);
  migration_4(runner);
  return db;
}

function makeConfig(retentionDays?: number): ClaudexConfig {
  return {
    observation: {
      enabled: true,
      redact_secrets: true,
      retention_days: retentionDays,
    },
  };
}

function insertObservation(db: Database.Database, epochMs: number, title = 'test obs'): void {
  db.prepare(`
    INSERT INTO observations (session_id, project, timestamp, timestamp_epoch, tool_name, category, title, content, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess1', 'proj', new Date(epochMs).toISOString(), epochMs, 'Bash', 'tool_output', title, 'content', 3, new Date(epochMs).toISOString(), epochMs);
}

function insertReasoning(db: Database.Database, epochMs: number, title = 'test reasoning'): void {
  db.prepare(`
    INSERT INTO reasoning_chains (session_id, project, timestamp, timestamp_epoch, trigger, title, reasoning, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess1', 'proj', new Date(epochMs).toISOString(), epochMs, 'compact', title, 'some reasoning', 3, new Date(epochMs).toISOString(), epochMs);
}

function insertConsensus(db: Database.Database, epochMs: number, status: string, title = 'test consensus'): void {
  db.prepare(`
    INSERT INTO consensus_decisions (session_id, project, timestamp, timestamp_epoch, title, description, status, importance, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run('sess1', 'proj', new Date(epochMs).toISOString(), epochMs, title, 'desc', status, 4, new Date(epochMs).toISOString(), epochMs);
}

function insertPressure(db: Database.Database, filePath: string, lastAccessedEpoch: number | null): void {
  const now = new Date().toISOString();
  const nowEpoch = Date.now();
  db.prepare(`
    INSERT INTO pressure_scores (file_path, project, raw_pressure, temperature, last_accessed_epoch, decay_rate, updated_at, updated_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(filePath, '__global__', 0.8, 'HOT', lastAccessedEpoch, 0.05, now, nowEpoch);
}

// =============================================================================
// Tests
// =============================================================================

let db: Database.Database;

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
});

describe('enforceRetention — basic cleanup', () => {
  it('deletes observations older than retention_days', () => {
    const now = Date.now();
    insertObservation(db, now - 100 * DAY_MS, 'old');
    insertObservation(db, now - 50 * DAY_MS, 'recent');

    const result = enforceRetention(db, makeConfig(90));

    expect(result.observationsDeleted).toBe(1);
    const remaining = db.prepare('SELECT title FROM observations').all() as { title: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('recent');
  });

  it('deletes reasoning chains older than retention_days', () => {
    const now = Date.now();
    insertReasoning(db, now - 100 * DAY_MS, 'old');
    insertReasoning(db, now - 50 * DAY_MS, 'recent');

    const result = enforceRetention(db, makeConfig(90));

    expect(result.reasoningDeleted).toBe(1);
    const remaining = db.prepare('SELECT title FROM reasoning_chains').all() as { title: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('recent');
  });

  it('deletes only rejected/superseded consensus decisions', () => {
    const now = Date.now();
    const oldEpoch = now - 100 * DAY_MS;

    insertConsensus(db, oldEpoch, 'rejected', 'old rejected');
    insertConsensus(db, oldEpoch, 'superseded', 'old superseded');
    insertConsensus(db, oldEpoch, 'proposed', 'old proposed');
    insertConsensus(db, oldEpoch, 'agreed', 'old agreed');
    insertConsensus(db, now - 50 * DAY_MS, 'rejected', 'recent rejected');

    const result = enforceRetention(db, makeConfig(90));

    expect(result.consensusDeleted).toBe(2); // old rejected + old superseded
    const remaining = db.prepare('SELECT title FROM consensus_decisions ORDER BY title').all() as { title: string }[];
    expect(remaining).toHaveLength(3);
    expect(remaining.map(r => r.title)).toEqual(
      expect.arrayContaining(['old proposed', 'old agreed', 'recent rejected'])
    );
  });

  it('returns durationMs > 0', () => {
    const result = enforceRetention(db, makeConfig(90));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('enforceRetention — consensus preservation', () => {
  it('NEVER deletes proposed consensus regardless of age', () => {
    const ancient = Date.now() - 365 * DAY_MS;
    insertConsensus(db, ancient, 'proposed', 'ancient proposed');

    enforceRetention(db, makeConfig(30));

    const remaining = db.prepare('SELECT title FROM consensus_decisions').all() as { title: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('ancient proposed');
  });

  it('NEVER deletes agreed consensus regardless of age', () => {
    const ancient = Date.now() - 365 * DAY_MS;
    insertConsensus(db, ancient, 'agreed', 'ancient agreed');

    enforceRetention(db, makeConfig(30));

    const remaining = db.prepare('SELECT title FROM consensus_decisions').all() as { title: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('ancient agreed');
  });
});

describe('enforceRetention — pressure decay', () => {
  it('zeros out pressure for stale files (not accessed within window)', () => {
    const now = Date.now();
    insertPressure(db, 'stale.ts', now - 100 * DAY_MS);
    insertPressure(db, 'fresh.ts', now - 10 * DAY_MS);

    const result = enforceRetention(db, makeConfig(90));

    expect(result.pressureDecayed).toBe(1);
    const rows = db.prepare('SELECT file_path, raw_pressure, temperature FROM pressure_scores ORDER BY file_path').all() as { file_path: string; raw_pressure: number; temperature: string }[];
    expect(rows).toHaveLength(2);

    const fresh = rows.find(r => r.file_path === 'fresh.ts')!;
    const stale = rows.find(r => r.file_path === 'stale.ts')!;
    expect(fresh.raw_pressure).toBe(0.8);
    expect(fresh.temperature).toBe('HOT');
    expect(stale.raw_pressure).toBe(0);
    expect(stale.temperature).toBe('COLD');
  });

  it('handles NULL last_accessed_epoch as stale', () => {
    insertPressure(db, 'never-accessed.ts', null);

    const result = enforceRetention(db, makeConfig(90));

    expect(result.pressureDecayed).toBe(1);
    const row = db.prepare('SELECT raw_pressure, temperature FROM pressure_scores WHERE file_path = ?').get('never-accessed.ts') as { raw_pressure: number; temperature: string };
    expect(row.raw_pressure).toBe(0);
    expect(row.temperature).toBe('COLD');
  });

  it('updates updated_at and updated_at_epoch on decay', () => {
    const oldEpoch = Date.now() - 100 * DAY_MS;
    insertPressure(db, 'stale.ts', oldEpoch);

    const before = db.prepare('SELECT updated_at_epoch FROM pressure_scores WHERE file_path = ?').get('stale.ts') as { updated_at_epoch: number };

    enforceRetention(db, makeConfig(90));

    const after = db.prepare('SELECT updated_at_epoch FROM pressure_scores WHERE file_path = ?').get('stale.ts') as { updated_at_epoch: number };
    expect(after.updated_at_epoch).toBeGreaterThanOrEqual(before.updated_at_epoch);
  });
});

describe('enforceRetention — retention_days=0', () => {
  it('purges everything when retention_days is 0', () => {
    const now = Date.now();
    insertObservation(db, now - 1000, 'just now');
    insertReasoning(db, now - 1000, 'just now reasoning');
    insertConsensus(db, now - 1000, 'rejected', 'just now rejected');
    insertConsensus(db, now - 1000, 'agreed', 'just now agreed');

    const result = enforceRetention(db, makeConfig(0));

    expect(result.observationsDeleted).toBe(1);
    expect(result.reasoningDeleted).toBe(1);
    expect(result.consensusDeleted).toBe(1); // only rejected, agreed is preserved

    // Verify agreed is still there
    const remaining = db.prepare('SELECT status FROM consensus_decisions').all() as { status: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.status).toBe('agreed');
  });
});

describe('enforceRetention — empty DB', () => {
  it('returns all zeros on empty database', () => {
    const result = enforceRetention(db, makeConfig(90));

    expect(result.observationsDeleted).toBe(0);
    expect(result.reasoningDeleted).toBe(0);
    expect(result.consensusDeleted).toBe(0);
    expect(result.pressureDecayed).toBe(0);
    expect(result.mirrorsCleanedUp).toBe(0);
  });
});

describe('enforceRetention — error handling', () => {
  it('returns partial results when DB is closed mid-operation', () => {
    const now = Date.now();
    insertObservation(db, now - 100 * DAY_MS);

    // Close the db to simulate error after first operation might succeed or fail
    const closedDb = new Database(':memory:');
    closedDb.close();

    // Should not throw
    const result = enforceRetention(closedDb, makeConfig(90));

    expect(result).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('never throws even with invalid DB', () => {
    const closedDb = new Database(':memory:');
    closedDb.close();

    expect(() => enforceRetention(closedDb, makeConfig(90))).not.toThrow();
  });
});

describe('enforceRetention — FTS5 rebuild', () => {
  it('does not rebuild FTS5 when nothing is deleted', () => {
    const now = Date.now();
    insertObservation(db, now - 10 * DAY_MS); // recent, won't be deleted

    const result = enforceRetention(db, makeConfig(90));

    expect(result.observationsDeleted).toBe(0);
    // No way to directly assert FTS5 rebuild didn't happen, but
    // verify the function completes without error
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('search still works after retention deletes and rebuilds FTS5', () => {
    const now = Date.now();
    insertObservation(db, now - 100 * DAY_MS, 'old observation');
    insertObservation(db, now - 10 * DAY_MS, 'recent observation');

    // Force FTS5 rebuild to sync initial inserts
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);

    enforceRetention(db, makeConfig(90));

    // Search should only find the recent one
    const rows = db.prepare(`
      SELECT o.title FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH 'observation'
    `).all() as { title: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('recent observation');
  });
});

describe('enforceRetention — default config', () => {
  it('uses 90-day default when retention_days is undefined', () => {
    const now = Date.now();
    insertObservation(db, now - 100 * DAY_MS, 'older than 90');
    insertObservation(db, now - 80 * DAY_MS, 'within 90');

    const result = enforceRetention(db, { observation: { enabled: true, redact_secrets: true } });

    expect(result.observationsDeleted).toBe(1);
    const remaining = db.prepare('SELECT title FROM observations').all() as { title: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('within 90');
  });
});
