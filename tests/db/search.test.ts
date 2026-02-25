import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { searchObservations, migration_2 } from '../../src/db/search.js';
import { migration_1 } from '../../src/db/schema.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { storeObservation } from '../../src/db/observations.js';
import type { Observation } from '../../src/shared/types.js';

// Mock logger to prevent filesystem writes during tests
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

function makeTestObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'test-session-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    tool_name: 'Read',
    category: 'discovery',
    title: 'Test observation',
    content: 'Test content body',
    importance: 3,
    ...overrides,
  };
}

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create schema_versions table (normally done by MigrationRunner)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const runner = new MigrationRunner(db);
  runner.run();

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

describe('searchObservations', () => {
  it('returns empty array for no matches', () => {
    storeObservation(db, makeTestObservation({ title: 'Something else' }));
    const results = searchObservations(db, 'nonexistentkeyword');
    expect(results).toEqual([]);
  });

  it('returns empty array for empty query', () => {
    storeObservation(db, makeTestObservation());
    const results = searchObservations(db, '');
    expect(results).toEqual([]);
  });

  it('returns empty array for whitespace-only query', () => {
    storeObservation(db, makeTestObservation());
    const results = searchObservations(db, '   ');
    expect(results).toEqual([]);
  });

  it('finds observations by title keyword', () => {
    storeObservation(db, makeTestObservation({ title: 'Database migration refactor' }));
    storeObservation(db, makeTestObservation({ title: 'UI button styling' }));

    const results = searchObservations(db, 'migration');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Database migration refactor');
  });

  it('finds observations by content keyword', () => {
    storeObservation(db, makeTestObservation({
      title: 'Edit A',
      content: 'Fixed the authentication middleware',
    }));
    storeObservation(db, makeTestObservation({
      title: 'Edit B',
      content: 'Updated the CSS styles for header',
    }));

    const results = searchObservations(db, 'authentication');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Edit A');
  });

  it('finds observations by facts keyword', () => {
    storeObservation(db, makeTestObservation({
      title: 'Discovery X',
      facts: ['uses React hooks', 'state managed by Redux'],
    }));
    storeObservation(db, makeTestObservation({
      title: 'Discovery Y',
      facts: ['uses Vue composition API'],
    }));

    const results = searchObservations(db, 'Redux');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Discovery X');
  });

  it('BM25 ranking: more relevant results rank higher', () => {
    // Insert one observation that mentions "typescript" once
    storeObservation(db, makeTestObservation({
      title: 'Minor note',
      content: 'Some typescript code',
    }));

    // Insert one that mentions it many times — should rank higher
    storeObservation(db, makeTestObservation({
      title: 'TypeScript deep dive',
      content: 'TypeScript types, TypeScript generics, TypeScript interfaces, TypeScript compiler, TypeScript strict mode',
    }));

    const results = searchObservations(db, 'typescript');
    expect(results.length).toBe(2);
    // BM25 in FTS5: lower rank values = more relevant (rank is negative)
    expect(results[0]!.rank).toBeLessThanOrEqual(results[1]!.rank);
  });

  it('snippet extraction works (highlights matched terms)', () => {
    storeObservation(db, makeTestObservation({
      title: 'Config update',
      content: 'The webpack configuration was updated to support tree-shaking',
    }));

    const results = searchObservations(db, 'webpack');
    expect(results.length).toBe(1);
    // Snippet should contain the bold markers used in the SQL query
    expect(results[0]!.snippet).toContain('<b>');
    expect(results[0]!.snippet).toContain('</b>');
  });

  it('FTS5 backfill: observations inserted BEFORE FTS5 migration are searchable', () => {
    // Create a fresh DB with only migration 1 (no FTS5 yet)
    const db2 = new Database(':memory:');
    db2.pragma('journal_mode = WAL');
    db2.pragma('foreign_keys = ON');
    db2.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);

    const runner2 = new MigrationRunner(db2);
    migration_1(runner2);

    // Insert observation BEFORE FTS5 migration
    storeObservation(db2, makeTestObservation({
      title: 'Backfill verification observation',
      content: 'This was inserted before the FTS5 table existed',
    }));

    // Now apply remaining migrations (2=FTS5 backfill, then 3-7 for deleted_at_epoch filter)
    runner2.run();

    // Search should find the pre-existing observation
    const results = searchObservations(db2, 'Backfill');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Backfill verification observation');

    db2.close();
  });

  it('special characters in search query do not crash (SQL injection safety)', () => {
    storeObservation(db, makeTestObservation({ title: 'Normal observation' }));

    // These should not throw — they should return empty or be handled gracefully
    expect(() => searchObservations(db, "Robert'; DROP TABLE observations;--")).not.toThrow();
    expect(() => searchObservations(db, '((((')).not.toThrow();
    expect(() => searchObservations(db, '"unclosed quote')).not.toThrow();
    expect(() => searchObservations(db, 'a AND OR NOT')).not.toThrow();
  });

  it('respects limit option', () => {
    for (let i = 0; i < 5; i++) {
      storeObservation(db, makeTestObservation({
        title: `Widget observation ${i}`,
        content: `Widget content ${i}`,
      }));
    }

    const results = searchObservations(db, 'Widget', { limit: 2 });
    expect(results.length).toBe(2);
  });

  it('filters by project when specified', () => {
    storeObservation(db, makeTestObservation({
      title: 'Project A work',
      content: 'Logging implementation',
      project: 'alpha',
    }));
    storeObservation(db, makeTestObservation({
      title: 'Project B work',
      content: 'Logging implementation',
      project: 'beta',
    }));

    const results = searchObservations(db, 'Logging', { project: 'alpha' });
    expect(results.length).toBe(1);
    expect(results[0]!.observation.project).toBe('alpha');
  });

  it('filters by minImportance', () => {
    storeObservation(db, makeTestObservation({
      title: 'Low importance note',
      content: 'Database query',
      importance: 1,
    }));
    storeObservation(db, makeTestObservation({
      title: 'High importance alert',
      content: 'Database outage',
      importance: 5,
    }));

    const results = searchObservations(db, 'Database', { minImportance: 3 });
    expect(results.length).toBe(1);
    expect(results[0]!.observation.importance).toBe(5);
  });

  it('finds hyphenated terms like "tree-shaking" (normalizer converts hyphen to space)', () => {
    storeObservation(db, makeTestObservation({
      title: 'Build optimization',
      content: 'Enabled tree-shaking to reduce bundle size',
    }));
    storeObservation(db, makeTestObservation({
      title: 'Different topic',
      content: 'Database indexing strategy',
    }));

    // Query with hyphen should match "tree-shaking" after normalization
    const results = searchObservations(db, 'tree-shaking');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.content).toContain('tree-shaking');
  });

  it('finds hyphenated terms like "error-handling"', () => {
    storeObservation(db, makeTestObservation({
      title: 'Middleware update',
      content: 'Improved error-handling for async operations',
    }));
    storeObservation(db, makeTestObservation({
      title: 'Unrelated',
      content: 'UI component styling',
    }));

    const results = searchObservations(db, 'error-handling');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.content).toContain('error-handling');
  });

  it('finds hyphenated terms like "pre-commit"', () => {
    storeObservation(db, makeTestObservation({
      title: 'CI/CD pipeline',
      content: 'Added pre-commit hooks for linting',
    }));
    storeObservation(db, makeTestObservation({
      title: 'Other work',
      content: 'Updated README',
    }));

    const results = searchObservations(db, 'pre-commit');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.content).toContain('pre-commit');
  });
});
