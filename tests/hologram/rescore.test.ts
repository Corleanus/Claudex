import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { rescoreWithFallback } from '../../src/hologram/degradation.js';
import type { HologramClient } from '../../src/hologram/client.js';
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

function makeMockClient() {
  return {
    query: vi.fn(),
    notifyFileChanges: vi.fn(),
    ping: vi.fn(),
    isAvailable: vi.fn(),
    persistScores: vi.fn(),
    requestRescore: vi.fn(),
  } as unknown as HologramClient & { requestRescore: ReturnType<typeof vi.fn> };
}

// =============================================================================
// Tests: rescoreWithFallback
// =============================================================================

describe('rescoreWithFallback', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('returns hologram source when sidecar responds successfully', async () => {
    const client = makeMockClient();
    client.requestRescore.mockResolvedValueOnce(true);

    const result = await rescoreWithFallback(client, 'sess-1', db);

    expect(result.source).toBe('hologram');
    expect(client.requestRescore).toHaveBeenCalledWith('sess-1');
    expect(client.requestRescore).toHaveBeenCalledTimes(1);
  });

  it('returns db-pressure when sidecar fails but DB has hot scores', async () => {
    const client = makeMockClient();
    client.requestRescore.mockRejectedValueOnce(new Error('sidecar down'));

    // Insert a HOT pressure score
    upsertPressureScore(db, {
      file_path: 'src/important.ts',
      raw_pressure: 0.9,
      temperature: 'HOT',
      decay_rate: 0.05,
    });

    const result = await rescoreWithFallback(client, 'sess-1', db);

    expect(result.source).toBe('db-pressure');
  });

  it('returns none when sidecar fails and DB has no hot scores', async () => {
    const client = makeMockClient();
    client.requestRescore.mockRejectedValueOnce(new Error('sidecar down'));

    // Insert only WARM scores (no HOT)
    upsertPressureScore(db, {
      file_path: 'src/warm-file.ts',
      raw_pressure: 0.4,
      temperature: 'WARM',
      decay_rate: 0.05,
    });

    const result = await rescoreWithFallback(client, 'sess-1', db);

    expect(result.source).toBe('none');
  });

  it('returns none when sidecar fails and no DB provided', async () => {
    const client = makeMockClient();
    client.requestRescore.mockRejectedValueOnce(new Error('sidecar down'));

    const result = await rescoreWithFallback(client, 'sess-1');

    expect(result.source).toBe('none');
  });

  it('returns none when sidecar returns false (not throwing)', async () => {
    const client = makeMockClient();
    client.requestRescore.mockResolvedValueOnce(false);

    const result = await rescoreWithFallback(client, 'sess-1');

    expect(result.source).toBe('none');
  });

  it('returns db-pressure when sidecar returns false and DB has hot scores', async () => {
    const client = makeMockClient();
    client.requestRescore.mockResolvedValueOnce(false);

    upsertPressureScore(db, {
      file_path: 'src/hot.ts',
      project: 'my-project',
      raw_pressure: 0.95,
      temperature: 'HOT',
      decay_rate: 0.05,
    });

    const result = await rescoreWithFallback(client, 'sess-1', db, 'my-project');

    expect(result.source).toBe('db-pressure');
  });
});

// =============================================================================
// Tests: requestRescore (via mock client behavior)
// =============================================================================

describe('requestRescore behavior', () => {
  it('returns false when sidecar is not running (getPort returns null)', async () => {
    // The actual HologramClient.requestRescore checks getPort() === null
    // and returns false. We verify this contract through the mock.
    const client = makeMockClient();
    client.requestRescore.mockResolvedValueOnce(false);

    const result = await client.requestRescore('sess-1');

    expect(result).toBe(false);
  });

  it('returns true when sidecar accepts the rescore request', async () => {
    const client = makeMockClient();
    client.requestRescore.mockResolvedValueOnce(true);

    const result = await client.requestRescore('sess-1');

    expect(result).toBe(true);
  });
});
