import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4, searchAll } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { storeObservation } from '../../src/db/observations.js';
import { insertReasoning } from '../../src/db/reasoning.js';
import { insertConsensus } from '../../src/db/consensus.js';
import { FTS5VectorStore } from '../../src/db/vectors.js';
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const runner = new MigrationRunner(db);
  migration_1(runner);  // observations + sessions tables
  migration_3(runner);  // reasoning_chains + consensus_decisions + pressure_scores
  migration_2(runner);  // FTS5 for observations
  migration_4(runner);  // FTS5 for reasoning + consensus
  return db;
}

function insertTestReasoning(db: Database.Database, overrides: Record<string, unknown> = {}): { id: number } {
  return insertReasoning(db, {
    session_id: 'test-session-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    trigger: 'pre_compact',
    title: 'Test reasoning chain',
    reasoning: 'Decided to use FTS5 because it provides built-in ranking',
    importance: 4,
    ...overrides,
  });
}

function insertTestConsensus(db: Database.Database, overrides: Record<string, unknown> = {}): { id: number } {
  return insertConsensus(db, {
    session_id: 'test-session-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    title: 'Test consensus decision',
    description: 'Agreed to use SQLite for local storage',
    status: 'agreed',
    importance: 4,
    ...overrides,
  });
}

// =============================================================================
// Tests
// =============================================================================

let db: Database.Database;
let store: FTS5VectorStore;

beforeEach(() => {
  db = setupDb();
  store = new FTS5VectorStore(db);
});

afterEach(() => {
  db.close();
});

describe('FTS5VectorStore', () => {
  // ===========================================================================
  // search
  // ===========================================================================
  describe('search', () => {
    it('returns empty array for no matches', () => {
      storeObservation(db, makeTestObservation({ title: 'Something unrelated' }));
      const results = store.search('nonexistentkeyword');
      expect(results).toEqual([]);
    });

    it('returns empty array for empty query', () => {
      storeObservation(db, makeTestObservation());
      const results = store.search('');
      expect(results).toEqual([]);
    });

    it('finds observations and returns VectorSearchResult format', () => {
      storeObservation(db, makeTestObservation({
        title: 'Webpack configuration refactor',
        content: 'Updated webpack config for tree shaking',
      }));

      const results = store.search('webpack');
      expect(results.length).toBe(1);

      const result = results[0]!;
      expect(result).toHaveProperty('id');
      expect(result).toHaveProperty('table');
      expect(result).toHaveProperty('title');
      expect(result).toHaveProperty('snippet');
      expect(result).toHaveProperty('score');

      expect(result.table).toBe('observations');
      expect(result.title).toBe('Webpack configuration refactor');
      expect(typeof result.id).toBe('number');
      expect(typeof result.score).toBe('number');
    });

    it('finds reasoning chains and maps table correctly', () => {
      insertTestReasoning(db, {
        title: 'Architecture pivot reasoning',
        reasoning: 'Decided to switch from REST to GraphQL for flexibility',
      });

      const results = store.search('GraphQL');
      expect(results.length).toBe(1);
      expect(results[0]!.table).toBe('reasoning_chains');
      expect(results[0]!.title).toBe('Architecture pivot reasoning');
    });

    it('finds consensus decisions and maps table correctly', () => {
      insertTestConsensus(db, {
        title: 'Database technology consensus',
        description: 'Agreed to use PostgreSQL for production deployment',
      });

      const results = store.search('PostgreSQL');
      expect(results.length).toBe(1);
      expect(results[0]!.table).toBe('consensus_decisions');
      expect(results[0]!.title).toBe('Database technology consensus');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        storeObservation(db, makeTestObservation({
          title: `Widget observation ${i}`,
          content: `Widget implementation details ${i}`,
        }));
      }

      const results = store.search('Widget', 2);
      expect(results.length).toBe(2);
    });

    it('returns results with positive score values', () => {
      storeObservation(db, makeTestObservation({
        title: 'TypeScript compiler analysis',
        content: 'Deep analysis of TypeScript strict mode',
      }));

      const results = store.search('TypeScript');
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.score).toBeGreaterThan(0);
      }
    });

    it('returns results from all tables in unified search', () => {
      storeObservation(db, makeTestObservation({
        title: 'Refactoring the authentication module',
        content: 'Authentication module needs rework',
      }));
      insertTestReasoning(db, {
        title: 'Authentication architecture reasoning',
        reasoning: 'Authentication should use JWT tokens for statelessness',
      });
      insertTestConsensus(db, {
        title: 'Authentication strategy consensus',
        description: 'Authentication will use OAuth2 with JWT',
      });

      const results = store.search('authentication');
      expect(results.length).toBe(3);

      const tables = results.map(r => r.table);
      expect(tables).toContain('observations');
      expect(tables).toContain('reasoning_chains');
      expect(tables).toContain('consensus_decisions');
    });
  });

  // ===========================================================================
  // searchByTable
  // ===========================================================================
  describe('searchByTable', () => {
    // Seed all three tables with the same keyword so we can verify filtering
    beforeEach(() => {
      storeObservation(db, makeTestObservation({
        title: 'Caching strategy observation',
        content: 'Implemented Redis caching layer',
      }));
      insertTestReasoning(db, {
        title: 'Caching reasoning chain',
        reasoning: 'Caching at the service layer reduces database load significantly',
      });
      insertTestConsensus(db, {
        title: 'Caching consensus',
        description: 'Caching will be implemented using Redis with 5 minute TTL',
      });
    });

    it('searches only observations when table=observations', () => {
      const results = store.searchByTable('caching', 'observations');
      expect(results.length).toBe(1);
      expect(results[0]!.table).toBe('observations');
      expect(results[0]!.title).toBe('Caching strategy observation');
    });

    it('searches only reasoning_chains when table=reasoning_chains', () => {
      const results = store.searchByTable('caching', 'reasoning_chains');
      expect(results.length).toBe(1);
      expect(results[0]!.table).toBe('reasoning_chains');
      expect(results[0]!.title).toBe('Caching reasoning chain');
    });

    it('searches only consensus_decisions when table=consensus_decisions', () => {
      const results = store.searchByTable('caching', 'consensus_decisions');
      expect(results.length).toBe(1);
      expect(results[0]!.table).toBe('consensus_decisions');
      expect(results[0]!.title).toBe('Caching consensus');
    });

    it('returns empty for unknown table name', () => {
      const results = store.searchByTable('caching', 'nonexistent_table');
      expect(results).toEqual([]);
    });
  });

  // ===========================================================================
  // FTS5 parity
  // ===========================================================================
  describe('FTS5 parity', () => {
    it('FTS5VectorStore.search returns same items as searchAll', () => {
      storeObservation(db, makeTestObservation({
        title: 'Deployment pipeline observation',
        content: 'Pipeline uses Docker containers for isolation',
      }));
      insertTestReasoning(db, {
        title: 'Deployment reasoning',
        reasoning: 'Deployment should use blue green strategy for zero downtime',
      });
      insertTestConsensus(db, {
        title: 'Deployment consensus',
        description: 'Deployment pipeline will use GitHub Actions with Docker',
      });

      const vectorResults = store.search('deployment');
      const searchAllResults = searchAll(db, 'deployment');

      // Same number of results
      expect(vectorResults.length).toBe(searchAllResults.length);

      // Same titles appear in both result sets (order may differ due to score transform)
      const vectorTitles = vectorResults.map(r => r.title).sort();
      const searchAllTitles = searchAllResults.map(r => r.observation.title).sort();
      expect(vectorTitles).toEqual(searchAllTitles);
    });

    it('FTS5VectorStore.search score is abs(rank) from searchAll', () => {
      storeObservation(db, makeTestObservation({
        title: 'Logging infrastructure',
        content: 'Structured logging with Winston',
      }));

      const vectorResults = store.search('logging');
      const searchAllResults = searchAll(db, 'logging');

      expect(vectorResults.length).toBe(1);
      expect(searchAllResults.length).toBe(1);

      expect(vectorResults[0]!.score).toBe(Math.abs(searchAllResults[0]!.rank));
    });
  });
});
