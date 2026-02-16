import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import {
  insertConsensus,
  updateConsensusStatus,
  getConsensusBySession,
  getRecentConsensus,
} from '../../src/db/consensus.js';
import type { ConsensusDecision } from '../../src/shared/types.js';

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

type ConsensusInput = Omit<ConsensusDecision, 'id' | 'created_at' | 'created_at_epoch'>;

function makeDecision(overrides: Partial<ConsensusInput> = {}): ConsensusInput {
  return {
    session_id: 'sess-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    title: 'Test consensus decision',
    description: 'A test description for the decision',
    status: 'proposed',
    importance: 4,
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

describe('insertConsensus', () => {
  it('inserts a consensus decision and returns id > 0', () => {
    const result = insertConsensus(db, makeDecision());
    expect(result.id).toBeGreaterThan(0);
  });

  it('stores optional fields (claude_position, codex_position, human_verdict)', () => {
    insertConsensus(db, makeDecision({
      claude_position: 'Use TCP sockets',
      codex_position: 'Agrees with TCP',
      human_verdict: 'Approved',
    }));

    const rows = getConsensusBySession(db, 'sess-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.claude_position).toBe('Use TCP sockets');
    expect(rows[0]!.codex_position).toBe('Agrees with TCP');
    expect(rows[0]!.human_verdict).toBe('Approved');
  });

  it('stores tags and files_affected as JSON arrays', () => {
    insertConsensus(db, makeDecision({
      tags: ['architecture', 'ipc'],
      files_affected: ['src/sidecar/launcher.ts'],
    }));

    const rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.tags).toEqual(['architecture', 'ipc']);
    expect(rows[0]!.files_affected).toEqual(['src/sidecar/launcher.ts']);
  });

  it('stores project as null when not provided', () => {
    insertConsensus(db, makeDecision());
    const rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.project).toBeUndefined();
  });
});

describe('updateConsensusStatus', () => {
  it('updates the status of an existing decision', () => {
    const { id } = insertConsensus(db, makeDecision({ status: 'proposed' }));
    updateConsensusStatus(db, id, 'agreed');

    const rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.status).toBe('agreed');
  });

  it('can transition through all valid statuses', () => {
    const { id } = insertConsensus(db, makeDecision({ status: 'proposed' }));

    updateConsensusStatus(db, id, 'agreed');
    let rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.status).toBe('agreed');

    updateConsensusStatus(db, id, 'superseded');
    rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.status).toBe('superseded');

    updateConsensusStatus(db, id, 'rejected');
    rows = getConsensusBySession(db, 'sess-001');
    expect(rows[0]!.status).toBe('rejected');
  });

  it('silently skips invalid status (does not throw)', () => {
    const { id } = insertConsensus(db, makeDecision({ status: 'proposed' }));

    // Cast to bypass TS check — testing runtime validation
    updateConsensusStatus(db, id, 'invalid_status' as any);

    const rows = getConsensusBySession(db, 'sess-001');
    // Status should remain unchanged
    expect(rows[0]!.status).toBe('proposed');
  });
});

describe('getConsensusBySession', () => {
  it('returns empty array for unknown session', () => {
    expect(getConsensusBySession(db, 'nonexistent')).toEqual([]);
  });

  it('returns decisions for the given session ordered by timestamp_epoch ASC', () => {
    insertConsensus(db, makeDecision({ session_id: 'sess-A', timestamp_epoch: 3000, title: 'Third' }));
    insertConsensus(db, makeDecision({ session_id: 'sess-A', timestamp_epoch: 1000, title: 'First' }));
    insertConsensus(db, makeDecision({ session_id: 'sess-A', timestamp_epoch: 2000, title: 'Second' }));
    insertConsensus(db, makeDecision({ session_id: 'sess-B', timestamp_epoch: 500, title: 'Other' }));

    const rows = getConsensusBySession(db, 'sess-A');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.title).toBe('First');
    expect(rows[1]!.title).toBe('Second');
    expect(rows[2]!.title).toBe('Third');
  });

  it('does not return decisions from other sessions', () => {
    insertConsensus(db, makeDecision({ session_id: 'sess-A' }));
    insertConsensus(db, makeDecision({ session_id: 'sess-B' }));

    const rows = getConsensusBySession(db, 'sess-A');
    expect(rows).toHaveLength(1);
  });

  it('handles malformed JSON in one row without losing other rows', () => {
    // Insert valid entries
    insertConsensus(db, makeDecision({ session_id: 'sess-test', title: 'First', tags: ['tag-A'] }));
    insertConsensus(db, makeDecision({ session_id: 'sess-test', title: 'Third', files_affected: ['file.ts'] }));

    // Manually inject corrupted JSON into tags field
    db.prepare(`
      INSERT INTO consensus_decisions (
        session_id, timestamp, timestamp_epoch, title, description,
        status, tags, importance, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sess-test',
      new Date().toISOString(),
      Date.now(),
      'Corrupted',
      'test description',
      'proposed',
      '["incomplete', // malformed JSON
      4,
      new Date().toISOString(),
      Date.now()
    );

    // Should return all 3 rows, with corrupted one using fallback
    const rows = getConsensusBySession(db, 'sess-test');
    expect(rows).toHaveLength(3);

    // Find the corrupted row
    const corruptRow = rows.find(r => r.title === 'Corrupted');
    expect(corruptRow).toBeDefined();
    expect(corruptRow!.tags).toEqual([]); // fallback to empty array

    // Valid rows should still have correct data
    const firstRow = rows.find(r => r.title === 'First');
    expect(firstRow!.tags).toEqual(['tag-A']);

    const thirdRow = rows.find(r => r.title === 'Third');
    expect(thirdRow!.files_affected).toEqual(['file.ts']);
  });
});

describe('getRecentConsensus', () => {
  it('returns most recent decisions ordered by timestamp_epoch DESC', () => {
    insertConsensus(db, makeDecision({ timestamp_epoch: 1000, title: 'Old' }));
    insertConsensus(db, makeDecision({ timestamp_epoch: 3000, title: 'New' }));
    insertConsensus(db, makeDecision({ timestamp_epoch: 2000, title: 'Mid' }));

    const rows = getRecentConsensus(db, 10);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.title).toBe('New');
    expect(rows[1]!.title).toBe('Mid');
    expect(rows[2]!.title).toBe('Old');
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      insertConsensus(db, makeDecision({ timestamp_epoch: i * 1000, title: `Decision ${i}` }));
    }
    const rows = getRecentConsensus(db, 2);
    expect(rows).toHaveLength(2);
  });

  it('filters by project when specified', () => {
    insertConsensus(db, makeDecision({ project: 'alpha', title: 'Alpha decision' }));
    insertConsensus(db, makeDecision({ project: 'beta', title: 'Beta decision' }));
    insertConsensus(db, makeDecision({ title: 'No project decision' }));

    const rows = getRecentConsensus(db, 10, 'alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Alpha decision');
  });

  it('returns all decisions when no project filter', () => {
    insertConsensus(db, makeDecision({ project: 'alpha' }));
    insertConsensus(db, makeDecision({ project: 'beta' }));
    insertConsensus(db, makeDecision());

    const rows = getRecentConsensus(db, 10);
    expect(rows).toHaveLength(3);
  });
});
