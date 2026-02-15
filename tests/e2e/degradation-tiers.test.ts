/**
 * Claudex v2 — E2E Degradation Tiers Test
 *
 * Tests the full degradation chain end-to-end:
 *   Tier 1: Hologram sidecar responds -> use hologram scores
 *   Tier 2: Sidecar down, DB has pressure scores -> use DB scores
 *   Tier 3: Both down -> use recency-based file list
 *
 * Each tier is tested through queryWithFallback and then fed into
 * assembleContext to verify the full data flow produces valid markdown.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ResilientHologramClient } from '../../src/hologram/degradation.js';
import { rescoreWithFallback } from '../../src/hologram/degradation.js';
import type { HologramClient } from '../../src/hologram/client.js';
import type { ClaudexConfig, HologramResponse, ContextSources } from '../../src/shared/types.js';
import { HologramUnavailableError } from '../../src/shared/errors.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import { assembleContext } from '../../src/lib/context-assembler.js';

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

const config: ClaudexConfig = {
  hologram: {
    enabled: true,
    timeout_ms: 1000,
    health_interval_ms: 30000,
  },
};

function makeMockClient() {
  return {
    query: vi.fn(),
    notifyFileChanges: vi.fn(),
    ping: vi.fn(),
    isAvailable: vi.fn(),
    persistScores: vi.fn(),
    requestRescore: vi.fn(),
  } as unknown as HologramClient & {
    query: ReturnType<typeof vi.fn>;
    requestRescore: ReturnType<typeof vi.fn>;
  };
}

/** Build minimal ContextSources from a HologramResponse (or null). */
function buildContextSources(hologram: HologramResponse | null): ContextSources {
  return {
    hologram,
    searchResults: [],
    recentObservations: [],
    scope: { type: 'global' },
  };
}

const tier1Response: HologramResponse = {
  hot: [
    { path: 'src/core/engine.ts', raw_pressure: 0.95, temperature: 'HOT', system_bucket: 0, pressure_bucket: 45 },
    { path: 'src/core/parser.ts', raw_pressure: 0.88, temperature: 'HOT', system_bucket: 0, pressure_bucket: 42 },
  ],
  warm: [
    { path: 'src/utils/helpers.ts', raw_pressure: 0.55, temperature: 'WARM', system_bucket: 0, pressure_bucket: 26 },
  ],
  cold: [
    { path: 'src/legacy/old.ts', raw_pressure: 0.1, temperature: 'COLD', system_bucket: 0, pressure_bucket: 5 },
  ],
};

// =============================================================================
// Tests
// =============================================================================

describe('Degradation Tiers E2E', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  // ===========================================================================
  // Tier 1: Full Stack (hologram available)
  // ===========================================================================

  describe('Tier 1: Full Stack (hologram available)', () => {
    it('uses hologram scores when sidecar responds', async () => {
      const mockClient = makeMockClient();
      mockClient.query.mockResolvedValueOnce(tier1Response);

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-1', ['recent.ts'], db,
      );

      expect(result.source).toBe('hologram');
      expect(result.hot).toHaveLength(2);
      expect(result.warm).toHaveLength(1);
      expect(result.cold).toHaveLength(1);
      expect(result.hot[0]!.path).toBe('src/core/engine.ts');
      expect(result.hot[1]!.path).toBe('src/core/parser.ts');
      expect(result.warm[0]!.path).toBe('src/utils/helpers.ts');
    });

    it('Tier 1 context includes Active Focus section from HOT files', async () => {
      const mockClient = makeMockClient();
      mockClient.query.mockResolvedValueOnce(tier1Response);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-1', [], db,
      );

      // Feed hologram result into context assembly
      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('Active Focus');
      expect(assembled.markdown).toContain('src/core/engine.ts');
      expect(assembled.markdown).toContain('src/core/parser.ts');
      expect(assembled.markdown).toContain('HOT');
    });

    it('Tier 1 context includes Warm Context section', async () => {
      const mockClient = makeMockClient();
      mockClient.query.mockResolvedValueOnce(tier1Response);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-1', [], db,
      );

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('src/utils/helpers.ts');
    });

    it('Tier 1 sources include hologram', async () => {
      const mockClient = makeMockClient();
      mockClient.query.mockResolvedValueOnce(tier1Response);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-1', [], db,
      );

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.sources).toContain('hologram');
    });
  });

  // ===========================================================================
  // Tier 2: DB Pressure Fallback
  // ===========================================================================

  describe('Tier 2: DB Pressure Fallback', () => {
    function failHologram(mockClient: ReturnType<typeof makeMockClient>) {
      mockClient.query
        .mockRejectedValueOnce(new HologramUnavailableError('sidecar down'))
        .mockRejectedValueOnce(new HologramUnavailableError('sidecar down'));
    }

    function seedDbScores() {
      upsertPressureScore(db, {
        file_path: 'src/db/queries.ts',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/db/schema.ts',
        raw_pressure: 0.85,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/db/utils.ts',
        raw_pressure: 0.5,
        temperature: 'WARM',
        decay_rate: 0.05,
      });
    }

    it('falls back to DB pressure scores when hologram fails', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);
      seedDbScores();

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-2', ['recent.ts'], db,
      );

      expect(result.source).toBe('db-pressure');
      expect(result.hot).toHaveLength(2);
      expect(result.warm).toHaveLength(1);
      expect(result.cold).toEqual([]);
      expect(result.hot[0]!.path).toBe('src/db/queries.ts');
      expect(result.hot[1]!.path).toBe('src/db/schema.ts');
      expect(result.warm[0]!.path).toBe('src/db/utils.ts');
    });

    it('DB scores produce ScoredFile objects with correct shape', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);
      seedDbScores();

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-2', [], db,
      );

      // Verify each HOT file has complete ScoredFile structure
      for (const file of result.hot) {
        expect(file).toHaveProperty('path');
        expect(file).toHaveProperty('raw_pressure');
        expect(file).toHaveProperty('temperature', 'HOT');
        expect(file).toHaveProperty('system_bucket', 0);
        expect(typeof file.pressure_bucket).toBe('number');
        expect(file.pressure_bucket).toBeGreaterThan(0);
      }

      // Verify WARM file structure
      for (const file of result.warm) {
        expect(file).toHaveProperty('path');
        expect(file).toHaveProperty('temperature', 'WARM');
        expect(typeof file.pressure_bucket).toBe('number');
      }
    });

    it('DB scores produce valid context assembly with file paths', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);
      seedDbScores();

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-2', [], db,
      );

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toBeTruthy();
      expect(assembled.markdown).toContain('Active Focus');
      expect(assembled.markdown).toContain('src/db/queries.ts');
      expect(assembled.markdown).toContain('src/db/schema.ts');
      expect(assembled.tokenEstimate).toBeGreaterThan(0);
    });

    it('DB fallback context includes Warm Context section for WARM files', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);
      seedDbScores();

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-2', [], db,
      );

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('src/db/utils.ts');
    });

    it('respects project scope when querying DB scores', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      // Seed scores for two different projects
      upsertPressureScore(db, {
        file_path: 'src/project-a.ts',
        project: 'project-a',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/project-b.ts',
        project: 'project-b',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-2', [], db, 'project-a',
      );

      expect(result.source).toBe('db-pressure');
      expect(result.hot).toHaveLength(1);
      expect(result.hot[0]!.path).toBe('src/project-a.ts');
    });
  });

  // ===========================================================================
  // Tier 3: Recency Fallback
  // ===========================================================================

  describe('Tier 3: Recency Fallback', () => {
    function failHologram(mockClient: ReturnType<typeof makeMockClient>) {
      mockClient.query
        .mockRejectedValueOnce(new HologramUnavailableError('sidecar down'))
        .mockRejectedValueOnce(new HologramUnavailableError('sidecar down'));
    }

    it('falls back to recency when hologram fails and DB is empty', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      const recentFiles = ['src/recently-edited.ts', 'src/also-recent.ts', 'config.json'];

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-3', recentFiles, db,
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.hot).toEqual([]);
      expect(result.warm).toHaveLength(3);
      expect(result.cold).toEqual([]);

      const warmPaths = result.warm.map(f => f.path);
      expect(warmPaths).toContain('src/recently-edited.ts');
      expect(warmPaths).toContain('src/also-recent.ts');
      expect(warmPaths).toContain('config.json');
    });

    it('recency fallback assigns WARM temperature with neutral scores', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-3', ['a.ts', 'b.ts'], db,
      );

      expect(result.source).toBe('recency-fallback');
      for (const file of result.warm) {
        expect(file.temperature).toBe('WARM');
        expect(file.raw_pressure).toBe(0.5);
        expect(file.system_bucket).toBe(0);
        expect(file.pressure_bucket).toBe(24);
      }
    });

    it('falls back to recency when no DB is provided', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      const resilient = new ResilientHologramClient(mockClient, config);
      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-3', ['only-recent.ts'],
        // no db parameter
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.warm).toHaveLength(1);
      expect(result.warm[0]!.path).toBe('only-recent.ts');
    });

    it('recency fallback produces valid context assembly', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-3', ['src/fallback-file.ts', 'src/another.ts'], db,
      );

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toBeTruthy();
      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('src/fallback-file.ts');
      expect(assembled.markdown).toContain('src/another.ts');
      expect(assembled.tokenEstimate).toBeGreaterThan(0);
    });

    it('recency fallback with empty recent files produces empty context', async () => {
      const mockClient = makeMockClient();
      failHologram(mockClient);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-e2e-3', [], db,
      );

      expect(suggestion.source).toBe('recency-fallback');
      expect(suggestion.warm).toEqual([]);

      const sources = buildContextSources(suggestion);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      // No hologram data, no search results, no observations -> empty
      expect(assembled.markdown).toBe('');
      expect(assembled.tokenEstimate).toBe(0);
    });
  });

  // ===========================================================================
  // Context assembly at each tier
  // ===========================================================================

  describe('context assembly at each tier', () => {
    it('Tier 1 context includes Active Focus section (HOT files)', async () => {
      const mockClient = makeMockClient();
      mockClient.query.mockResolvedValueOnce(tier1Response);

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'prompt', 1, 'sess-ctx-1', [], db,
      );

      const assembled = assembleContext(buildContextSources(suggestion), { maxTokens: 4000 });

      expect(assembled.markdown).toContain('## Active Focus');
      expect(assembled.markdown).toContain('src/core/engine.ts');
      expect(assembled.markdown).toContain('pressure: 0.95');
    });

    it('Tier 2 context includes file paths from DB', async () => {
      const mockClient = makeMockClient();
      mockClient.query
        .mockRejectedValueOnce(new HologramUnavailableError('down'))
        .mockRejectedValueOnce(new HologramUnavailableError('down'));

      upsertPressureScore(db, {
        file_path: 'src/db-fallback.ts',
        raw_pressure: 0.88,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'prompt', 1, 'sess-ctx-2', [], db,
      );

      const assembled = assembleContext(buildContextSources(suggestion), { maxTokens: 4000 });

      expect(assembled.markdown).toContain('src/db-fallback.ts');
      expect(assembled.markdown).toContain('## Active Focus');
    });

    it('Tier 3 context includes Warm Context section', async () => {
      const mockClient = makeMockClient();
      mockClient.query
        .mockRejectedValueOnce(new HologramUnavailableError('down'))
        .mockRejectedValueOnce(new HologramUnavailableError('down'));

      const resilient = new ResilientHologramClient(mockClient, config);
      const suggestion = await resilient.queryWithFallback(
        'prompt', 1, 'sess-ctx-3', ['src/recency-file.ts'], db,
      );

      const assembled = assembleContext(buildContextSources(suggestion), { maxTokens: 4000 });

      expect(assembled.markdown).toContain('## Warm Context');
      expect(assembled.markdown).toContain('src/recency-file.ts');
    });

    it('all tiers produce markdown starting with Context header', async () => {
      // Tier 1
      const mock1 = makeMockClient();
      mock1.query.mockResolvedValueOnce(tier1Response);
      const r1 = new ResilientHologramClient(mock1, config);
      const s1 = await r1.queryWithFallback('p', 1, 's1', [], db);
      const a1 = assembleContext(buildContextSources(s1), { maxTokens: 4000 });

      // Tier 2
      const mock2 = makeMockClient();
      mock2.query
        .mockRejectedValueOnce(new HologramUnavailableError('down'))
        .mockRejectedValueOnce(new HologramUnavailableError('down'));
      upsertPressureScore(db, {
        file_path: 'tier2.ts',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      const r2 = new ResilientHologramClient(mock2, config);
      const s2 = await r2.queryWithFallback('p', 1, 's2', [], db);
      const a2 = assembleContext(buildContextSources(s2), { maxTokens: 4000 });

      // Tier 3
      const mock3 = makeMockClient();
      mock3.query
        .mockRejectedValueOnce(new HologramUnavailableError('down'))
        .mockRejectedValueOnce(new HologramUnavailableError('down'));
      // Use a fresh DB to avoid tier2 scores leaking
      const emptyDb = setupDb();
      const r3 = new ResilientHologramClient(mock3, config);
      const s3 = await r3.queryWithFallback('p', 1, 's3', ['warm.ts'], emptyDb);
      const a3 = assembleContext(buildContextSources(s3), { maxTokens: 4000 });
      emptyDb.close();

      expect(a1.markdown).toMatch(/^# Context \(auto-injected by Claudex\)/);
      expect(a2.markdown).toMatch(/^# Context \(auto-injected by Claudex\)/);
      expect(a3.markdown).toMatch(/^# Context \(auto-injected by Claudex\)/);
    });

    it('token estimates increase with more content', async () => {
      // Tier 3 (minimal content) vs Tier 1 (rich content)
      const mock1 = makeMockClient();
      mock1.query.mockResolvedValueOnce(tier1Response);
      const r1 = new ResilientHologramClient(mock1, config);
      const s1 = await r1.queryWithFallback('p', 1, 's1', [], db);
      const a1 = assembleContext(buildContextSources(s1), { maxTokens: 4000 });

      const emptyDb = setupDb();
      const mock3 = makeMockClient();
      mock3.query
        .mockRejectedValueOnce(new HologramUnavailableError('down'))
        .mockRejectedValueOnce(new HologramUnavailableError('down'));
      const r3 = new ResilientHologramClient(mock3, config);
      const s3 = await r3.queryWithFallback('p', 1, 's3', ['one.ts'], emptyDb);
      const a3 = assembleContext(buildContextSources(s3), { maxTokens: 4000 });
      emptyDb.close();

      // Tier 1 with HOT + WARM files should have more tokens than Tier 3 with one WARM file
      expect(a1.tokenEstimate).toBeGreaterThan(a3.tokenEstimate);
    });
  });

  // ===========================================================================
  // rescoreWithFallback integration
  // ===========================================================================

  describe('rescoreWithFallback integration', () => {
    it('returns hologram source when sidecar rescore succeeds', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockResolvedValueOnce(true);

      const result = await rescoreWithFallback(mockClient, 'sess-rescore-1', db);

      expect(result.source).toBe('hologram');
    });

    it('falls back to db-pressure when sidecar rescore fails and DB has HOT scores', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockRejectedValueOnce(new Error('sidecar gone'));

      upsertPressureScore(db, {
        file_path: 'src/rescore-hot.ts',
        raw_pressure: 0.92,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const result = await rescoreWithFallback(mockClient, 'sess-rescore-2', db);

      expect(result.source).toBe('db-pressure');
    });

    it('returns none when sidecar fails and DB has no HOT scores', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockRejectedValueOnce(new Error('sidecar gone'));

      const result = await rescoreWithFallback(mockClient, 'sess-rescore-3', db);

      expect(result.source).toBe('none');
    });

    it('returns none when sidecar fails and no DB provided', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockRejectedValueOnce(new Error('sidecar gone'));

      const result = await rescoreWithFallback(mockClient, 'sess-rescore-4');

      expect(result.source).toBe('none');
    });

    it('returns none when sidecar returns false (not error)', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockResolvedValueOnce(false);

      // No HOT scores in DB
      const result = await rescoreWithFallback(mockClient, 'sess-rescore-5', db);

      expect(result.source).toBe('none');
    });
  });

  // ===========================================================================
  // Cross-tier: never throws
  // ===========================================================================

  describe('never throws regardless of tier', () => {
    it('queryWithFallback never throws even with all systems down', async () => {
      const mockClient = makeMockClient();
      mockClient.query
        .mockRejectedValueOnce(new Error('catastrophic'))
        .mockRejectedValueOnce(new Error('catastrophic'));

      const resilient = new ResilientHologramClient(mockClient, config);

      // Should not throw — should gracefully fall back to recency
      const result = await resilient.queryWithFallback(
        'prompt', 1, 'sess-safe', ['safe.ts'], db,
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.warm).toHaveLength(1);
    });

    it('rescoreWithFallback never throws', async () => {
      const mockClient = makeMockClient();
      mockClient.requestRescore.mockRejectedValueOnce(new Error('catastrophic'));

      // Should not throw
      const result = await rescoreWithFallback(mockClient, 'sess-safe', db);

      expect(result.source).toBe('none');
    });
  });
});
