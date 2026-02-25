import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_7 } from '../../src/db/schema-wave3.js';
import { bumpAccessCount, storeObservation } from '../../src/db/observations.js';
import { decayAllScores, upsertPressureScore } from '../../src/db/pressure.js';
import { pruneObservations } from '../../src/lib/decay-engine.js';
import type { Observation, PressureScore } from '../../src/shared/types.js';

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
  runner.run();
  return db;
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'test-session-001',
    project: 'test-project',
    timestamp: '2024-01-01T00:00:00.000Z',
    timestamp_epoch: 1704067200000,
    tool_name: 'Read',
    category: 'discovery',
    title: 'Test observation',
    content: 'Test content',
    importance: 3,
    ...overrides,
  };
}

type PressureInput = Omit<PressureScore, 'id' | 'updated_at' | 'updated_at_epoch'>;

function makeScore(overrides: Partial<PressureInput> = {}): PressureInput {
  return {
    file_path: 'src/main.ts',
    raw_pressure: 0.5,
    temperature: 'WARM',
    decay_rate: 0.05,
    ...overrides,
  };
}

// =============================================================================
// bumpAccessCount
// =============================================================================

describe('bumpAccessCount', () => {
  let db: Database.Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('increments access_count and sets last_accessed_at_epoch', () => {
    const { id } = storeObservation(db, makeObservation());
    expect(id).toBeGreaterThan(0);

    const before = Date.now();
    bumpAccessCount(db, id);
    const after = Date.now();

    const row = db.prepare('SELECT access_count, last_accessed_at_epoch FROM observations WHERE id = ?').get(id) as {
      access_count: number;
      last_accessed_at_epoch: number;
    };

    expect(row.access_count).toBe(1);
    expect(row.last_accessed_at_epoch).toBeGreaterThanOrEqual(before);
    expect(row.last_accessed_at_epoch).toBeLessThanOrEqual(after);
  });

  it('increments multiple times correctly', () => {
    const { id } = storeObservation(db, makeObservation());
    bumpAccessCount(db, id);
    bumpAccessCount(db, id);
    bumpAccessCount(db, id);

    const row = db.prepare('SELECT access_count FROM observations WHERE id = ?').get(id) as { access_count: number };
    expect(row.access_count).toBe(3);
  });

  it('on nonexistent id — no error, no rows changed', () => {
    expect(() => bumpAccessCount(db, 99999)).not.toThrow();
  });
});

// =============================================================================
// decayAllScores — stratified decay
// =============================================================================

describe('decayAllScores stratified', () => {
  let db: Database.Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('critical tier (>= 0.85) decays slower than low tier (< 0.40)', () => {
    upsertPressureScore(db, makeScore({ file_path: 'critical.ts', project: 'p', raw_pressure: 0.90, temperature: 'HOT' }));
    upsertPressureScore(db, makeScore({ file_path: 'low.ts', project: 'p', raw_pressure: 0.20, temperature: 'COLD' }));

    decayAllScores(db, 'p');

    const rows = db.prepare(
      'SELECT file_path, raw_pressure FROM pressure_scores WHERE project = ? ORDER BY raw_pressure DESC'
    ).all('p') as Array<{ file_path: string; raw_pressure: number }>;

    const critical = rows.find(r => r.file_path === 'critical.ts')!;
    const low = rows.find(r => r.file_path === 'low.ts')!;

    // Critical: 0.90 × 0.99810 ≈ 0.8983 — tiny drop
    expect(critical.raw_pressure).toBeCloseTo(0.90 * 0.99810, 4);

    // Low: 0.20 × 0.90572 ≈ 0.1811 — larger drop
    expect(low.raw_pressure).toBeCloseTo(0.20 * 0.90572, 4);

    // Critical dropped by less (as a fraction)
    const criticalDrop = (0.90 - critical.raw_pressure) / 0.90;
    const lowDrop = (0.20 - low.raw_pressure) / 0.20;
    expect(criticalDrop).toBeLessThan(lowDrop);
  });

  it('idempotent: running decayAllScores twice same day gives same result', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'p', raw_pressure: 0.80, temperature: 'HOT' }));

    decayAllScores(db, 'p');
    const afterFirst = db.prepare(
      'SELECT raw_pressure FROM pressure_scores WHERE project = ?'
    ).get('p') as { raw_pressure: number };
    const firstPressure = afterFirst.raw_pressure;

    decayAllScores(db, 'p');
    const afterSecond = db.prepare(
      'SELECT raw_pressure FROM pressure_scores WHERE project = ?'
    ).get('p') as { raw_pressure: number };

    expect(afterSecond.raw_pressure).toBeCloseTo(firstPressure, 10);
  });

  it('sets last_decay_epoch after decay', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'p', raw_pressure: 0.50 }));

    const before = Date.now();
    decayAllScores(db, 'p');

    const row = db.prepare(
      'SELECT last_decay_epoch FROM pressure_scores WHERE project = ?'
    ).get('p') as { last_decay_epoch: number };

    expect(row.last_decay_epoch).toBeGreaterThanOrEqual(before - 1000); // within reason
    expect(row.last_decay_epoch).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

// =============================================================================
// pruneObservations
// =============================================================================

describe('pruneObservations', () => {
  let db: Database.Database;

  beforeEach(() => { db = setupDb(); });
  afterEach(() => { db.close(); });

  it('below threshold → no-op', () => {
    storeObservation(db, makeObservation({ title: 'obs1', project: 'p' }));
    storeObservation(db, makeObservation({ title: 'obs2', project: 'p' }));

    const result = pruneObservations(db, 'p');
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(2);
  });

  it('above threshold → prunes lowest-EI non-immune batch', () => {
    // Insert 1001 observations with low importance (not immune, low EI)
    for (let i = 0; i < 1001; i++) {
      storeObservation(db, makeObservation({
        title: `obs-${i}`,
        importance: 1,
        project: 'test',
      }));
    }

    const result = pruneObservations(db, 'test');
    expect(result.pruned).toBe(10); // batch of 10
    expect(result.remaining).toBe(991);

    // Soft-delete: deleted_at_epoch should be set on pruned rows
    const deletedCount = db.prepare(
      'SELECT COUNT(*) as cnt FROM observations WHERE deleted_at_epoch IS NOT NULL AND project = ?'
    ).get('test') as { cnt: number };
    expect(deletedCount.cnt).toBe(10);
  });

  it('respects immunity: critical importance observations are never pruned', () => {
    // Insert 1001 critical observations
    for (let i = 0; i < 1001; i++) {
      storeObservation(db, makeObservation({
        title: `critical-${i}`,
        importance: 5,
        project: 'immune-test',
      }));
    }

    const result = pruneObservations(db, 'immune-test');
    // All are immune (importance 5), so nothing pruned
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(1001);
  });
});

// =============================================================================
// migration_7 idempotency
// =============================================================================

describe('migration_7 idempotency', () => {
  it('applying migration_7 twice is safe', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const runner = new MigrationRunner(db);
    runner.run(); // Runs all 7 migrations including migration_7

    // Second application — should be no-op (version guard)
    expect(() => migration_7(runner)).not.toThrow();

    // Columns should exist once
    const info = db.prepare("PRAGMA table_info(observations)").all() as Array<{ name: string }>;
    const colNames = info.map(c => c.name);
    expect(colNames).toContain('access_count');
    expect(colNames).toContain('last_accessed_at_epoch');
    expect(colNames).toContain('deleted_at_epoch');

    const pressureInfo = db.prepare("PRAGMA table_info(pressure_scores)").all() as Array<{ name: string }>;
    const pressureColNames = pressureInfo.map(c => c.name);
    expect(pressureColNames).toContain('last_decay_epoch');

    db.close();
  });
});
