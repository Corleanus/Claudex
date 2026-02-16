import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import {
  insertReasoning,
  getReasoningBySession,
  getRecentReasoning,
  searchReasoning,
} from '../../src/db/reasoning.js';
import type { ReasoningChain } from '../../src/shared/types.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

type ReasoningInput = Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'>;

function makeChain(overrides: Partial<ReasoningInput> = {}): ReasoningInput {
  return {
    session_id: 'sess-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    trigger: 'pre_compact',
    title: 'Test reasoning chain',
    reasoning: 'Some reasoning content here',
    importance: 3,
    ...overrides,
  };
}

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

describe('insertReasoning', () => {
  it('inserts a reasoning chain and returns id > 0', () => {
    const result = insertReasoning(db, makeChain());
    expect(result.id).toBeGreaterThan(0);
  });

  it('stores decisions and files_involved as JSON', () => {
    const result = insertReasoning(db, makeChain({
      decisions: ['Use TCP socket', 'Defer vectors'],
      files_involved: ['src/db/schema.ts', 'src/hooks/session-start.ts'],
    }));
    expect(result.id).toBeGreaterThan(0);

    const rows = getReasoningBySession(db, 'sess-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decisions).toEqual(['Use TCP socket', 'Defer vectors']);
    expect(rows[0]!.files_involved).toEqual(['src/db/schema.ts', 'src/hooks/session-start.ts']);
  });

  it('stores project as null when not provided', () => {
    insertReasoning(db, makeChain());
    const rows = getReasoningBySession(db, 'sess-001');
    expect(rows[0]!.project).toBeUndefined();
  });

  it('stores project when provided', () => {
    insertReasoning(db, makeChain({ project: 'claudex' }));
    const rows = getReasoningBySession(db, 'sess-001');
    expect(rows[0]!.project).toBe('claudex');
  });
});

describe('getReasoningBySession', () => {
  it('returns empty array for unknown session', () => {
    const rows = getReasoningBySession(db, 'nonexistent');
    expect(rows).toEqual([]);
  });

  it('returns chains for the given session ordered by timestamp_epoch ASC', () => {
    insertReasoning(db, makeChain({ session_id: 'sess-A', timestamp_epoch: 3000, title: 'Third' }));
    insertReasoning(db, makeChain({ session_id: 'sess-A', timestamp_epoch: 1000, title: 'First' }));
    insertReasoning(db, makeChain({ session_id: 'sess-A', timestamp_epoch: 2000, title: 'Second' }));
    insertReasoning(db, makeChain({ session_id: 'sess-B', timestamp_epoch: 500, title: 'Other session' }));

    const rows = getReasoningBySession(db, 'sess-A');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.title).toBe('First');
    expect(rows[1]!.title).toBe('Second');
    expect(rows[2]!.title).toBe('Third');
  });

  it('handles malformed JSON in one row without losing other rows', () => {
    // Insert valid entries
    insertReasoning(db, makeChain({ session_id: 'sess-test', title: 'First', decisions: ['decide-A'] }));
    insertReasoning(db, makeChain({ session_id: 'sess-test', title: 'Third', files_involved: ['file.ts'] }));

    // Manually inject corrupted JSON into decisions field
    db.prepare(`
      INSERT INTO reasoning_chains (
        session_id, timestamp, timestamp_epoch, trigger, title, reasoning,
        decisions, importance, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sess-test',
      new Date().toISOString(),
      Date.now(),
      'pre_compact',
      'Corrupted',
      'reasoning text',
      '{"broken": ', // malformed JSON
      3,
      new Date().toISOString(),
      Date.now()
    );

    // Should return all 3 rows, with corrupted one using fallback
    const rows = getReasoningBySession(db, 'sess-test');
    expect(rows).toHaveLength(3);

    // Find the corrupted row
    const corruptRow = rows.find(r => r.title === 'Corrupted');
    expect(corruptRow).toBeDefined();
    expect(corruptRow!.decisions).toEqual([]); // fallback to empty array

    // Valid rows should still have correct data
    const firstRow = rows.find(r => r.title === 'First');
    expect(firstRow!.decisions).toEqual(['decide-A']);

    const thirdRow = rows.find(r => r.title === 'Third');
    expect(thirdRow!.files_involved).toEqual(['file.ts']);
  });
});

describe('getRecentReasoning', () => {
  it('returns most recent chains ordered by timestamp_epoch DESC', () => {
    insertReasoning(db, makeChain({ timestamp_epoch: 1000, title: 'Old' }));
    insertReasoning(db, makeChain({ timestamp_epoch: 3000, title: 'New' }));
    insertReasoning(db, makeChain({ timestamp_epoch: 2000, title: 'Mid' }));

    const rows = getRecentReasoning(db, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.title).toBe('New');
    expect(rows[1]!.title).toBe('Mid');
    expect(rows[2]!.title).toBe('Old');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      insertReasoning(db, makeChain({ timestamp_epoch: i * 1000, title: `Chain ${i}` }));
    }
    const rows = getRecentReasoning(db, 2);
    expect(rows).toHaveLength(2);
  });

  it('filters by project when specified', () => {
    insertReasoning(db, makeChain({ project: 'alpha', title: 'Alpha chain' }));
    insertReasoning(db, makeChain({ project: 'beta', title: 'Beta chain' }));
    insertReasoning(db, makeChain({ title: 'No project chain' }));

    const rows = getRecentReasoning(db, 10, 'alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Alpha chain');
  });

  it('returns all chains when no project filter', () => {
    insertReasoning(db, makeChain({ project: 'alpha' }));
    insertReasoning(db, makeChain({ project: 'beta' }));
    insertReasoning(db, makeChain());

    const rows = getRecentReasoning(db, 10);
    expect(rows).toHaveLength(3);
  });
});

describe('searchReasoning', () => {
  it('returns empty array for empty query', () => {
    insertReasoning(db, makeChain());
    expect(searchReasoning(db, '')).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    insertReasoning(db, makeChain());
    expect(searchReasoning(db, '   ')).toEqual([]);
  });

  it('finds chains by title keyword (LIKE search)', () => {
    insertReasoning(db, makeChain({ title: 'Database migration plan' }));
    insertReasoning(db, makeChain({ title: 'UI refactor plan' }));

    const rows = searchReasoning(db, 'migration');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Database migration plan');
  });

  it('finds chains by reasoning content keyword', () => {
    insertReasoning(db, makeChain({
      title: 'Chain A',
      reasoning: 'We chose TCP sockets for IPC',
    }));
    insertReasoning(db, makeChain({
      title: 'Chain B',
      reasoning: 'The UI needs a complete rewrite',
    }));

    const rows = searchReasoning(db, 'TCP');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Chain A');
  });

  it('filters by project when specified', () => {
    insertReasoning(db, makeChain({ project: 'alpha', title: 'Alpha reasoning', reasoning: 'shared keyword' }));
    insertReasoning(db, makeChain({ project: 'beta', title: 'Beta reasoning', reasoning: 'shared keyword' }));

    const rows = searchReasoning(db, 'shared', { project: 'alpha' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Alpha reasoning');
  });

  it('returns no results when nothing matches', () => {
    insertReasoning(db, makeChain({ title: 'Something', reasoning: 'else entirely' }));
    const rows = searchReasoning(db, 'nonexistentkeyword');
    expect(rows).toEqual([]);
  });
});
