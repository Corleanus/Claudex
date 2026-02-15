import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  searchReasoning,
  searchConsensus,
  searchAll,
  rebuildSearchIndex,
  optimizeSearchIndex,
  migration_2,
  migration_4,
} from '../../src/db/search.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { storeObservation } from '../../src/db/observations.js';
import { insertReasoning } from '../../src/db/reasoning.js';
import { insertConsensus } from '../../src/db/consensus.js';
import type { Observation, ReasoningChain, ConsensusDecision } from '../../src/shared/types.js';

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

function makeObservation(overrides: Partial<Observation> = {}): Observation {
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

function makeReasoning(
  overrides: Partial<Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'>> = {},
): Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'> {
  return {
    session_id: 'test-session-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    trigger: 'manual',
    title: 'Test reasoning chain',
    reasoning: 'Test reasoning body',
    importance: 3,
    ...overrides,
  };
}

function makeConsensus(
  overrides: Partial<Omit<ConsensusDecision, 'id' | 'created_at' | 'created_at_epoch'>> = {},
): Omit<ConsensusDecision, 'id' | 'created_at' | 'created_at_epoch'> {
  return {
    session_id: 'test-session-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    title: 'Test consensus decision',
    description: 'Test description body',
    status: 'proposed',
    importance: 4,
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

describe('searchReasoning', () => {
  it('returns empty array for empty query', () => {
    insertReasoning(db, makeReasoning());
    const results = searchReasoning(db, '');
    expect(results).toEqual([]);
  });

  it('finds reasoning by title keyword', () => {
    insertReasoning(db, makeReasoning({ title: 'Database schema migration plan' }));
    insertReasoning(db, makeReasoning({ title: 'UI layout decisions' }));

    const results = searchReasoning(db, 'migration');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Database schema migration plan');
  });

  it('finds reasoning by reasoning content keyword', () => {
    insertReasoning(db, makeReasoning({
      title: 'Chain A',
      reasoning: 'We chose TypeScript for type safety benefits',
    }));
    insertReasoning(db, makeReasoning({
      title: 'Chain B',
      reasoning: 'Python was selected for the sidecar component',
    }));

    const results = searchReasoning(db, 'TypeScript');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Chain A');
  });

  it('respects project filter', () => {
    insertReasoning(db, makeReasoning({
      title: 'Alpha reasoning flow',
      reasoning: 'Shared keyword architecture',
      project: 'alpha',
    }));
    insertReasoning(db, makeReasoning({
      title: 'Beta reasoning flow',
      reasoning: 'Shared keyword architecture',
      project: 'beta',
    }));

    const results = searchReasoning(db, 'architecture', { project: 'alpha' });
    expect(results.length).toBe(1);
    expect(results[0]!.observation.project).toBe('alpha');
  });

  it('returns snippet with highlighted matches', () => {
    insertReasoning(db, makeReasoning({
      title: 'Webpack analysis',
      reasoning: 'The webpack bundler configuration was analyzed for performance',
    }));

    const results = searchReasoning(db, 'webpack');
    expect(results.length).toBe(1);
    expect(results[0]!.snippet).toContain('<b>');
    expect(results[0]!.snippet).toContain('</b>');
  });
});

describe('searchConsensus', () => {
  it('returns empty array for empty query', () => {
    insertConsensus(db, makeConsensus());
    const results = searchConsensus(db, '');
    expect(results).toEqual([]);
  });

  it('finds consensus by title keyword', () => {
    insertConsensus(db, makeConsensus({ title: 'Use SQLite for storage layer' }));
    insertConsensus(db, makeConsensus({ title: 'Adopt vitest for testing' }));

    const results = searchConsensus(db, 'SQLite');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Use SQLite for storage layer');
  });

  it('finds consensus by description keyword', () => {
    insertConsensus(db, makeConsensus({
      title: 'Decision A',
      description: 'Hologram sidecar communicates over TCP socket protocol',
    }));
    insertConsensus(db, makeConsensus({
      title: 'Decision B',
      description: 'Hooks use esbuild for fast bundling',
    }));

    const results = searchConsensus(db, 'TCP');
    expect(results.length).toBe(1);
    expect(results[0]!.observation.title).toBe('Decision A');
  });

  it('respects project filter', () => {
    insertConsensus(db, makeConsensus({
      title: 'Alpha consensus pattern',
      description: 'Shared keyword deployment',
      project: 'alpha',
    }));
    insertConsensus(db, makeConsensus({
      title: 'Beta consensus pattern',
      description: 'Shared keyword deployment',
      project: 'beta',
    }));

    const results = searchConsensus(db, 'deployment', { project: 'beta' });
    expect(results.length).toBe(1);
    expect(results[0]!.observation.project).toBe('beta');
  });
});

describe('searchAll', () => {
  it('returns results from all three tables', () => {
    storeObservation(db, makeObservation({
      title: 'Kubernetes observation',
      content: 'Kubernetes cluster analysis',
    }));
    insertReasoning(db, makeReasoning({
      title: 'Kubernetes reasoning',
      reasoning: 'Kubernetes deployment strategy',
    }));
    insertConsensus(db, makeConsensus({
      title: 'Kubernetes consensus',
      description: 'Kubernetes orchestration decision',
    }));

    const results = searchAll(db, 'Kubernetes');
    expect(results.length).toBe(3);

    // Verify all 3 source types present (mapped via tool_name)
    const toolNames = results.map(r => r.observation.tool_name);
    expect(toolNames).toContain('Read');        // observation
    expect(toolNames).toContain('Flow');        // reasoning
    expect(toolNames).toContain('Consensus');   // consensus
  });

  it('respects limit across merged results', () => {
    // Insert 5 of each type
    for (let i = 0; i < 5; i++) {
      storeObservation(db, makeObservation({
        title: `Widget observation ${i}`,
        content: `Widget content ${i}`,
      }));
      insertReasoning(db, makeReasoning({
        title: `Widget reasoning ${i}`,
        reasoning: `Widget reasoning body ${i}`,
      }));
      insertConsensus(db, makeConsensus({
        title: `Widget consensus ${i}`,
        description: `Widget consensus body ${i}`,
      }));
    }

    const results = searchAll(db, 'Widget', { limit: 3 });
    expect(results.length).toBe(3);
  });

  it('respects project filter', () => {
    storeObservation(db, makeObservation({
      title: 'Scoped observation deploy',
      content: 'Deploy analysis',
      project: 'proj-x',
    }));
    insertReasoning(db, makeReasoning({
      title: 'Scoped reasoning deploy',
      reasoning: 'Deploy strategy',
      project: 'proj-x',
    }));
    insertConsensus(db, makeConsensus({
      title: 'Scoped consensus deploy',
      description: 'Deploy decision',
      project: 'proj-y',
    }));

    const results = searchAll(db, 'deploy', { project: 'proj-x' });
    expect(results.length).toBe(2);
    results.forEach(r => expect(r.observation.project).toBe('proj-x'));
  });

  it('returns empty array for empty query', () => {
    storeObservation(db, makeObservation());
    const results = searchAll(db, '');
    expect(results).toEqual([]);
  });

  it('BM25 ranking: more relevant results rank higher', () => {
    // One reasoning with a single mention
    insertReasoning(db, makeReasoning({
      title: 'Minor note',
      reasoning: 'Some refactoring code',
    }));

    // One with many mentions — should rank higher (lower rank value)
    insertReasoning(db, makeReasoning({
      title: 'Refactoring deep dive',
      reasoning: 'Refactoring patterns, refactoring tools, refactoring strategy, refactoring steps, refactoring gains',
    }));

    const results = searchAll(db, 'refactoring');
    expect(results.length).toBe(2);
    // BM25 in FTS5: lower rank values = more relevant
    expect(results[0]!.rank).toBeLessThanOrEqual(results[1]!.rank);
  });
});

describe('rebuildSearchIndex', () => {
  it('does not crash and indexes remain valid after rebuild', () => {
    storeObservation(db, makeObservation({ title: 'Rebuild test obs' }));
    insertReasoning(db, makeReasoning({ title: 'Rebuild test reasoning' }));
    insertConsensus(db, makeConsensus({ title: 'Rebuild test consensus' }));

    expect(() => rebuildSearchIndex(db)).not.toThrow();

    // Verify indexes still work after rebuild
    const obsResults = searchAll(db, 'Rebuild');
    expect(obsResults.length).toBe(3);
  });
});

describe('optimizeSearchIndex', () => {
  it('does not crash', () => {
    storeObservation(db, makeObservation({ title: 'Optimize test' }));
    insertReasoning(db, makeReasoning({ title: 'Optimize reasoning' }));
    insertConsensus(db, makeConsensus({ title: 'Optimize consensus' }));

    expect(() => optimizeSearchIndex(db)).not.toThrow();
  });
});
