/**
 * Claudex v2 — checkpoint_state CRUD + delta query tests
 *
 * Tests for:
 *   - checkpoint_state insert, update, read (Test #14)
 *   - getObservationsSince delta query (Test #13)
 *   - Global scope null filter (Test #15)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { migration_5 } from '../../src/db/schema-phase3.js';
import { migration_6 } from '../../src/db/schema-phase10.js';
import {
  getCheckpointState,
  upsertCheckpointState,
  updateBoostState,
} from '../../src/db/checkpoint.js';
import {
  getObservationsSince,
  storeObservation,
} from '../../src/db/observations.js';
import type { Observation } from '../../src/shared/types.js';

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
  migration_5(runner);
  migration_6(runner);
  return db;
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'test-session',
    project: 'test-project',
    timestamp: '2024-01-01T00:00:00.000Z',
    timestamp_epoch: 1704067200000,
    tool_name: 'Read',
    category: 'change',
    title: 'Test observation',
    content: 'Test content',
    importance: 3,
    files_read: ['src/foo.ts'],
    files_modified: ['src/bar.ts'],
    ...overrides,
  };
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

describe('checkpoint_state CRUD (Test #14)', () => {
  it('returns null for non-existent session', () => {
    const state = getCheckpointState(db, 'non-existent');
    expect(state).toBeNull();
  });

  it('inserts a new checkpoint state', () => {
    const result = upsertCheckpointState(db, 'sess-1', 1704067200000, ['src/a.ts', 'src/b.ts']);
    expect(result).toBe(true);

    const state = getCheckpointState(db, 'sess-1');
    expect(state).not.toBeNull();
    expect(state!.session_id).toBe('sess-1');
    expect(state!.last_epoch).toBe(1704067200000);
    expect(state!.active_files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(state!.boost_applied_at).toBeUndefined();
    // boost_turn_count has DEFAULT 0 in schema, so it's 0 not undefined when not explicitly set
    expect(state!.boost_turn_count).toBe(0);
  });

  it('updates existing checkpoint state via upsert', () => {
    upsertCheckpointState(db, 'sess-1', 1704067200000, ['src/a.ts']);

    // Upsert with new values
    upsertCheckpointState(db, 'sess-1', 1704067300000, ['src/a.ts', 'src/c.ts']);

    const state = getCheckpointState(db, 'sess-1');
    expect(state!.last_epoch).toBe(1704067300000);
    expect(state!.active_files).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('handles empty active_files array', () => {
    upsertCheckpointState(db, 'sess-1', 1704067200000, []);

    const state = getCheckpointState(db, 'sess-1');
    expect(state!.active_files).toEqual([]);
  });

  it('updateBoostState sets boost fields', () => {
    upsertCheckpointState(db, 'sess-1', 1704067200000, ['src/a.ts']);

    const result = updateBoostState(db, 'sess-1', 1704067300000, 1);
    expect(result).toBe(true);

    const state = getCheckpointState(db, 'sess-1');
    expect(state!.boost_applied_at).toBe(1704067300000);
    expect(state!.boost_turn_count).toBe(1);
  });

  it('updateBoostState returns false for non-existent session', () => {
    const result = updateBoostState(db, 'non-existent', 1704067300000, 1);
    expect(result).toBe(false);
  });

  it('multiple sessions are independent', () => {
    upsertCheckpointState(db, 'sess-1', 1000000000000, ['a.ts']);
    upsertCheckpointState(db, 'sess-2', 2000000000000, ['b.ts']);

    const s1 = getCheckpointState(db, 'sess-1');
    const s2 = getCheckpointState(db, 'sess-2');

    expect(s1!.last_epoch).toBe(1000000000000);
    expect(s1!.active_files).toEqual(['a.ts']);
    expect(s2!.last_epoch).toBe(2000000000000);
    expect(s2!.active_files).toEqual(['b.ts']);
  });
});

describe('getObservationsSince — delta query (Test #13)', () => {
  it('returns only observations after given epoch', () => {
    storeObservation(db, makeObservation({ title: 'Old', timestamp_epoch: 1704067100000 }));
    storeObservation(db, makeObservation({ title: 'New', timestamp_epoch: 1704067300000 }));
    storeObservation(db, makeObservation({ title: 'Newest', timestamp_epoch: 1704067400000 }));

    const results = getObservationsSince(db, 1704067200000, 'test-project');
    expect(results.length).toBe(2);
    // Ordered by timestamp_epoch DESC
    expect(results[0]!.title).toBe('Newest');
    expect(results[1]!.title).toBe('New');
  });

  it('returns empty array when no observations after epoch', () => {
    storeObservation(db, makeObservation({ title: 'Old', timestamp_epoch: 1704067100000 }));

    const results = getObservationsSince(db, 1704067200000, 'test-project');
    expect(results).toEqual([]);
  });

  it('returns all observations when epoch is 0', () => {
    storeObservation(db, makeObservation({ title: 'A', timestamp_epoch: 1704067100000 }));
    storeObservation(db, makeObservation({ title: 'B', timestamp_epoch: 1704067200000 }));
    storeObservation(db, makeObservation({ title: 'C', timestamp_epoch: 1704067300000 }));

    const results = getObservationsSince(db, 0, 'test-project');
    expect(results.length).toBe(3);
  });

  it('filters by project name', () => {
    storeObservation(db, makeObservation({ title: 'ProjectA', project: 'projA', timestamp_epoch: 1704067300000 }));
    storeObservation(db, makeObservation({ title: 'ProjectB', project: 'projB', timestamp_epoch: 1704067300000 }));

    const results = getObservationsSince(db, 0, 'projA');
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('ProjectA');
  });

  it('returns all projects when project is undefined', () => {
    storeObservation(db, makeObservation({ title: 'ProjA', project: 'projA', timestamp_epoch: 1704067300000 }));
    storeObservation(db, makeObservation({ title: 'ProjB', project: 'projB', timestamp_epoch: 1704067300000 }));

    const results = getObservationsSince(db, 0, undefined);
    expect(results.length).toBe(2);
  });
});

describe('Global scope null filter (Test #15)', () => {
  it('null project returns only global-scope observations (project IS NULL)', () => {
    // Global observation (project=null via undefined)
    storeObservation(db, makeObservation({
      title: 'Global',
      project: undefined,
      timestamp_epoch: 1704067300000,
    }));
    // Project-scoped observation
    storeObservation(db, makeObservation({
      title: 'Scoped',
      project: 'myproject',
      timestamp_epoch: 1704067300000,
    }));

    const results = getObservationsSince(db, 0, null);
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe('Global');
  });

  it('null project does not leak cross-project data', () => {
    storeObservation(db, makeObservation({
      title: 'ProjA',
      project: 'projA',
      timestamp_epoch: 1704067300000,
    }));
    storeObservation(db, makeObservation({
      title: 'ProjB',
      project: 'projB',
      timestamp_epoch: 1704067300000,
    }));

    const results = getObservationsSince(db, 0, null);
    expect(results.length).toBe(0);
  });
});

describe('migration_6 — checkpoint_state table', () => {
  it('checkpoint_state table exists after migration', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='checkpoint_state'")
      .all() as Array<{ name: string }>;
    expect(tables.length).toBe(1);
    expect(tables[0]!.name).toBe('checkpoint_state');
  });

  it('migration 6 is idempotent', () => {
    // Running all migrations again should not throw
    const runner = new MigrationRunner(db);
    expect(() => migration_6(runner)).not.toThrow();
  });
});
