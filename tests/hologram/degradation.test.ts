import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ResilientHologramClient } from '../../src/hologram/degradation.js';
import type { HologramClient } from '../../src/hologram/client.js';
import type { ClaudexConfig, HologramResponse } from '../../src/shared/types.js';
import { HologramUnavailableError } from '../../src/shared/errors.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { upsertPressureScore } from '../../src/db/pressure.js';

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
  } as unknown as HologramClient & { query: ReturnType<typeof vi.fn> };
}

const successResponse: HologramResponse = {
  hot: [{ path: 'src/main.ts', raw_pressure: 0.9, temperature: 'HOT', system_bucket: 0, pressure_bucket: 43 }],
  warm: [{ path: 'src/utils.ts', raw_pressure: 0.5, temperature: 'WARM', system_bucket: 0, pressure_bucket: 24 }],
  cold: [],
};

// =============================================================================
// Tests
// =============================================================================

describe('ResilientHologramClient', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns hologram source on first success', async () => {
    const mockClient = makeMockClient();
    mockClient.query.mockResolvedValueOnce(successResponse);

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['recent.ts'],
    );

    expect(result.source).toBe('hologram');
    expect(result.hot).toEqual(successResponse.hot);
    expect(result.warm).toEqual(successResponse.warm);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it('returns hologram source after retry on first failure', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('first fail'))
      .mockResolvedValueOnce(successResponse);

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['recent.ts'],
    );

    expect(result.source).toBe('hologram');
    expect(mockClient.query).toHaveBeenCalledTimes(2);
  });

  it('skips retry and falls to fallback when sidecar is confirmed dead', async () => {
    const mockClient = makeMockClient();
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('sidecar dead'));
    // isAvailable returns false (default) — sidecar confirmed dead

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['recent.ts'],
    );

    expect(result.source).toBe('recency-fallback');
    expect(mockClient.query).toHaveBeenCalledTimes(1); // No retry!
  });

  it('falls back to db-pressure when hologram fails both tries and DB has scores', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('fail 1'))
      .mockRejectedValueOnce(new HologramUnavailableError('fail 2'));

    // Insert pressure scores into the DB
    upsertPressureScore(db, {
      file_path: 'src/hot-file.ts',
      raw_pressure: 0.85,
      temperature: 'HOT',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/warm-file.ts',
      raw_pressure: 0.45,
      temperature: 'WARM',
      decay_rate: 0.05,
    });

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['recent.ts'], db,
    );

    expect(result.source).toBe('db-pressure');
    expect(result.hot.length).toBe(1);
    expect(result.hot[0]!.path).toBe('src/hot-file.ts');
    expect(result.warm.length).toBe(1);
    expect(result.warm[0]!.path).toBe('src/warm-file.ts');
    expect(result.cold).toEqual([]);
  });

  it('falls back to recency-fallback when hologram fails and DB has no scores', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('fail 1'))
      .mockRejectedValueOnce(new HologramUnavailableError('fail 2'));

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['a.ts', 'b.ts'], db,
    );

    expect(result.source).toBe('recency-fallback');
    expect(result.hot).toEqual([]);
    expect(result.warm.length).toBe(2);
    expect(result.warm[0]!.path).toBe('a.ts');
    expect(result.warm[1]!.path).toBe('b.ts');
  });

  it('falls back to recency-fallback when hologram fails and no DB provided', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('fail 1'))
      .mockRejectedValueOnce(new HologramUnavailableError('fail 2'));

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', ['x.ts'],
    );

    expect(result.source).toBe('recency-fallback');
    expect(result.hot).toEqual([]);
    expect(result.warm.length).toBe(1);
    expect(result.warm[0]!.path).toBe('x.ts');
  });

  it('db-pressure maps HOT and WARM files to ScoredFile format', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('fail 1'))
      .mockRejectedValueOnce(new HologramUnavailableError('fail 2'));

    upsertPressureScore(db, {
      file_path: 'src/core.ts',
      raw_pressure: 0.92,
      temperature: 'HOT',
      decay_rate: 0.05,
    });
    upsertPressureScore(db, {
      file_path: 'src/helper.ts',
      raw_pressure: 0.4,
      temperature: 'WARM',
      decay_rate: 0.05,
    });

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'test prompt', 1, 'sess-1', [], db,
    );

    expect(result.source).toBe('db-pressure');

    // Verify ScoredFile shape on HOT file
    const hot = result.hot[0]!;
    expect(hot.path).toBe('src/core.ts');
    expect(hot.raw_pressure).toBe(0.92);
    expect(hot.temperature).toBe('HOT');
    expect(typeof hot.system_bucket).toBe('number');
    expect(typeof hot.pressure_bucket).toBe('number');

    // Verify ScoredFile shape on WARM file
    const warm = result.warm[0]!;
    expect(warm.path).toBe('src/helper.ts');
    expect(warm.raw_pressure).toBe(0.4);
    expect(warm.temperature).toBe('WARM');
    expect(typeof warm.system_bucket).toBe('number');
    expect(typeof warm.pressure_bucket).toBe('number');
  });

  it('recency-fallback assigns WARM temperature with neutral pressure', async () => {
    const mockClient = makeMockClient();
    (mockClient as any).isAvailable.mockReturnValue(true);
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('fail'))
      .mockRejectedValueOnce(new HologramUnavailableError('fail'));

    const resilient = new ResilientHologramClient(mockClient, config);
    const result = await resilient.queryWithFallback(
      'prompt', 1, 'sess-1', ['file1.ts', 'file2.ts'],
    );

    expect(result.source).toBe('recency-fallback');
    for (const file of result.warm) {
      expect(file.temperature).toBe('WARM');
      expect(file.raw_pressure).toBe(0.5);
      expect(file.system_bucket).toBe(0);
      expect(file.pressure_bucket).toBe(24);
    }
  });

  it('uses config timeout_ms (default 2000 when hologram config missing)', async () => {
    const mockClient = makeMockClient();
    mockClient.query.mockResolvedValueOnce(successResponse);

    // Config without hologram section — should fall back to 2000ms internally
    const minimalConfig: ClaudexConfig = {};
    const resilient = new ResilientHologramClient(mockClient, minimalConfig);
    const result = await resilient.queryWithFallback(
      'prompt', 1, 'sess-1', [],
    );

    expect(result.source).toBe('hologram');
  });
});
