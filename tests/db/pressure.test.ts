import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import {
  upsertPressureScore,
  getPressureScores,
  getHotFiles,
  getWarmFiles,
  decayAllScores,
  accumulatePressureScore,
} from '../../src/db/pressure.js';
import type { PressureScore } from '../../src/shared/types.js';

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

describe('upsertPressureScore', () => {
  it('inserts a new pressure score', () => {
    upsertPressureScore(db, makeScore({ file_path: 'src/app.ts', project: 'alpha' }));
    const rows = getPressureScores(db, 'alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_path).toBe('src/app.ts');
    expect(rows[0]!.raw_pressure).toBe(0.5);
  });

  it('updates existing score for same file_path + project', () => {
    upsertPressureScore(db, makeScore({ file_path: 'src/app.ts', project: 'alpha', raw_pressure: 0.3 }));
    upsertPressureScore(db, makeScore({ file_path: 'src/app.ts', project: 'alpha', raw_pressure: 0.9, temperature: 'HOT' }));

    const rows = getPressureScores(db, 'alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_pressure).toBe(0.9);
    expect(rows[0]!.temperature).toBe('HOT');
  });

  it('uses __global__ sentinel when no project is provided', () => {
    upsertPressureScore(db, makeScore({ file_path: 'src/global.ts' }));

    // Query with the sentinel to verify it was stored correctly
    const rows = getPressureScores(db, '__global__');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_path).toBe('src/global.ts');
    expect(rows[0]!.project).toBe('__global__');
  });

  it('does not create duplicates on repeated global upsert', () => {
    upsertPressureScore(db, makeScore({ file_path: 'src/global.ts', raw_pressure: 0.2 }));
    upsertPressureScore(db, makeScore({ file_path: 'src/global.ts', raw_pressure: 0.8 }));
    upsertPressureScore(db, makeScore({ file_path: 'src/global.ts', raw_pressure: 0.6 }));

    const rows = getPressureScores(db, '__global__');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.raw_pressure).toBe(0.6);
  });

  it('keeps separate entries for same file in different projects', () => {
    upsertPressureScore(db, makeScore({ file_path: 'src/shared.ts', project: 'alpha', raw_pressure: 0.3 }));
    upsertPressureScore(db, makeScore({ file_path: 'src/shared.ts', project: 'beta', raw_pressure: 0.7 }));

    const alpha = getPressureScores(db, 'alpha');
    const beta = getPressureScores(db, 'beta');
    expect(alpha).toHaveLength(1);
    expect(beta).toHaveLength(1);
    expect(alpha[0]!.raw_pressure).toBe(0.3);
    expect(beta[0]!.raw_pressure).toBe(0.7);
  });

  it('rejects project name "__global__" to avoid sentinel collision', () => {
    // Attempt to insert with reserved project name
    upsertPressureScore(db, makeScore({
      file_path: 'src/reserved.ts',
      project: '__global__',
      raw_pressure: 0.8
    }));

    // Should NOT create a row because the project name is reserved
    const rows = getPressureScores(db, '__global__');
    // Only the sentinel-based entries (project: undefined) should exist, not user-provided '__global__'
    expect(rows).toHaveLength(0);
  });
});

describe('getPressureScores', () => {
  it('returns empty array when no scores exist', () => {
    expect(getPressureScores(db)).toEqual([]);
  });

  it('returns all scores when no project filter (ordered by raw_pressure DESC)', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'alpha', raw_pressure: 0.2 }));
    upsertPressureScore(db, makeScore({ file_path: 'b.ts', project: 'beta', raw_pressure: 0.9 }));
    upsertPressureScore(db, makeScore({ file_path: 'c.ts', raw_pressure: 0.5 }));

    const rows = getPressureScores(db);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.raw_pressure).toBe(0.9);
    expect(rows[2]!.raw_pressure).toBe(0.2);
  });

  it('filters by project', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'alpha' }));
    upsertPressureScore(db, makeScore({ file_path: 'b.ts', project: 'beta' }));

    const rows = getPressureScores(db, 'alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_path).toBe('a.ts');
  });
});

describe('getHotFiles', () => {
  it('returns only HOT temperature files', () => {
    upsertPressureScore(db, makeScore({ file_path: 'hot.ts', project: 'p', raw_pressure: 0.9, temperature: 'HOT' }));
    upsertPressureScore(db, makeScore({ file_path: 'warm.ts', project: 'p', raw_pressure: 0.5, temperature: 'WARM' }));
    upsertPressureScore(db, makeScore({ file_path: 'cold.ts', project: 'p', raw_pressure: 0.1, temperature: 'COLD' }));

    const rows = getHotFiles(db, 'p');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_path).toBe('hot.ts');
    expect(rows[0]!.temperature).toBe('HOT');
  });

  it('returns empty when no HOT files exist', () => {
    upsertPressureScore(db, makeScore({ file_path: 'warm.ts', project: 'p', temperature: 'WARM' }));
    expect(getHotFiles(db, 'p')).toEqual([]);
  });

  it('returns all HOT files across projects when no filter', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'alpha', temperature: 'HOT' }));
    upsertPressureScore(db, makeScore({ file_path: 'b.ts', project: 'beta', temperature: 'HOT' }));
    upsertPressureScore(db, makeScore({ file_path: 'c.ts', project: 'alpha', temperature: 'WARM' }));

    const rows = getHotFiles(db);
    expect(rows).toHaveLength(2);
  });
});

describe('getWarmFiles', () => {
  it('returns only WARM temperature files', () => {
    upsertPressureScore(db, makeScore({ file_path: 'hot.ts', project: 'p', temperature: 'HOT' }));
    upsertPressureScore(db, makeScore({ file_path: 'warm.ts', project: 'p', temperature: 'WARM' }));
    upsertPressureScore(db, makeScore({ file_path: 'cold.ts', project: 'p', temperature: 'COLD' }));

    const rows = getWarmFiles(db, 'p');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.file_path).toBe('warm.ts');
    expect(rows[0]!.temperature).toBe('WARM');
  });

  it('returns empty when no WARM files exist', () => {
    upsertPressureScore(db, makeScore({ file_path: 'hot.ts', project: 'p', temperature: 'HOT' }));
    expect(getWarmFiles(db, 'p')).toEqual([]);
  });
});

describe('epoch validation', () => {
  it('converts seconds to milliseconds for last_accessed_epoch', () => {
    // Epoch for 2021-01-01 in seconds
    const secondsEpoch = 1609459200;
    upsertPressureScore(db, makeScore({
      file_path: 'test.ts',
      project: 'p',
      last_accessed_epoch: secondsEpoch,
    }));

    const rows = getPressureScores(db, 'p');
    // Should be stored as milliseconds
    expect(rows[0]!.last_accessed_epoch).toBe(1609459200000);
  });

  it('keeps milliseconds unchanged for last_accessed_epoch', () => {
    const msEpoch = 1609459200000;
    upsertPressureScore(db, makeScore({
      file_path: 'test.ts',
      project: 'p',
      last_accessed_epoch: msEpoch,
    }));

    const rows = getPressureScores(db, 'p');
    expect(rows[0]!.last_accessed_epoch).toBe(msEpoch);
  });

  it('handles undefined last_accessed_epoch', () => {
    upsertPressureScore(db, makeScore({
      file_path: 'test.ts',
      project: 'p',
    }));

    const rows = getPressureScores(db, 'p');
    expect(rows[0]!.last_accessed_epoch).toBeUndefined();
  });
});

describe('accumulatePressureScore', () => {
  it('accumulates pressure on repeated touches', () => {
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);

    const rows = getPressureScores(db, 'alpha');
    expect(rows).toHaveLength(1);
    // After 3 touches with diminishing returns:
    // Touch 1: 0.15
    // Touch 2: 0.15 + 0.15*(1-0.15) = 0.15 + 0.1275 = 0.2775
    // Touch 3: 0.2775 + 0.15*(1-0.2775) = 0.2775 + 0.108375 = 0.385875
    expect(rows[0]!.raw_pressure).toBeGreaterThan(0.15);
    expect(rows[0]!.raw_pressure).toBeLessThan(1.0);
  });

  it('applies diminishing returns — each touch adds less', () => {
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    const afterFirst = getPressureScores(db, 'alpha');
    const p1 = afterFirst[0]!.raw_pressure;

    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    const afterSecond = getPressureScores(db, 'alpha');
    const p2 = afterSecond[0]!.raw_pressure;
    const delta1 = p2 - p1;

    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    const afterThird = getPressureScores(db, 'alpha');
    const p3 = afterThird[0]!.raw_pressure;
    const delta2 = p3 - p2;

    // Each subsequent touch adds less than the previous
    expect(delta2).toBeLessThan(delta1);
  });

  it('transitions temperature from COLD to WARM to HOT', () => {
    // Start with a small increment — should be COLD
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.05);
    let rows = getPressureScores(db, 'alpha');
    expect(rows[0]!.temperature).toBe('COLD');

    // Accumulate until WARM (>= 0.3)
    for (let i = 0; i < 20; i++) {
      accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.05);
    }
    rows = getPressureScores(db, 'alpha');
    expect(rows[0]!.raw_pressure).toBeGreaterThanOrEqual(0.3);
    expect(rows[0]!.temperature).toBe('WARM');

    // Accumulate until HOT (>= 0.7)
    for (let i = 0; i < 60; i++) {
      accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.05);
    }
    rows = getPressureScores(db, 'alpha');
    expect(rows[0]!.raw_pressure).toBeGreaterThanOrEqual(0.7);
    expect(rows[0]!.temperature).toBe('HOT');
  });

  it('does not exceed 1.0 even after many touches', () => {
    for (let i = 0; i < 50; i++) {
      accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    }
    const rows = getPressureScores(db, 'alpha');
    expect(rows[0]!.raw_pressure).toBeLessThanOrEqual(1.0);
  });

  it('isolates pressure by project', () => {
    accumulatePressureScore(db, 'src/main.ts', 'project-a', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'project-a', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'project-a', 0.15);

    const projectA = getPressureScores(db, 'project-a');
    const projectB = getPressureScores(db, 'project-b');

    expect(projectA).toHaveLength(1);
    expect(projectA[0]!.raw_pressure).toBeGreaterThan(0.15);
    expect(projectB).toHaveLength(0);
  });

  it('coexists with upsertPressureScore — upsert overwrites accumulated value', () => {
    // Accumulate a score
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);
    accumulatePressureScore(db, 'src/main.ts', 'alpha', 0.15);

    const before = getPressureScores(db, 'alpha');
    expect(before[0]!.raw_pressure).toBeGreaterThan(0.15);

    // Hologram overwrites with upsert
    upsertPressureScore(db, makeScore({
      file_path: 'src/main.ts',
      project: 'alpha',
      raw_pressure: 0.9,
      temperature: 'HOT',
    }));

    const after = getPressureScores(db, 'alpha');
    expect(after).toHaveLength(1);
    expect(after[0]!.raw_pressure).toBe(0.9);
    expect(after[0]!.temperature).toBe('HOT');
  });

  it('handles closed DB gracefully', () => {
    const closedDb = setupDb();
    closedDb.close();

    // Should not throw
    expect(() => {
      accumulatePressureScore(closedDb, 'src/main.ts', 'alpha', 0.15);
    }).not.toThrow();
  });
});

describe('decayAllScores', () => {
  it('reduces raw_pressure values', () => {
    upsertPressureScore(db, makeScore({
      file_path: 'a.ts', project: 'p', raw_pressure: 1.0, temperature: 'HOT', decay_rate: 0.1,
    }));

    const changed = decayAllScores(db, 'p');
    expect(changed).toBe(1);

    const rows = getPressureScores(db, 'p');
    // 1.0 * (1 - 0.1) = 0.9
    expect(rows[0]!.raw_pressure).toBeCloseTo(0.9, 5);
  });

  it('reclassifies temperature after decay', () => {
    // Start at HOT (0.75), decay_rate 0.1 → 0.75 * 0.9 = 0.675 → should become WARM
    upsertPressureScore(db, makeScore({
      file_path: 'borderline.ts', project: 'p', raw_pressure: 0.75, temperature: 'HOT', decay_rate: 0.1,
    }));

    decayAllScores(db, 'p');

    const rows = getPressureScores(db, 'p');
    expect(rows[0]!.raw_pressure).toBeCloseTo(0.675, 5);
    expect(rows[0]!.temperature).toBe('WARM');
  });

  it('score at exactly 0.7 boundary becomes WARM after decay', () => {
    // 0.7 * (1 - 0.05) = 0.665 → WARM (>= 0.3 but < 0.7)
    upsertPressureScore(db, makeScore({
      file_path: 'boundary.ts', project: 'p', raw_pressure: 0.7, temperature: 'HOT', decay_rate: 0.05,
    }));

    decayAllScores(db, 'p');

    const rows = getPressureScores(db, 'p');
    expect(rows[0]!.raw_pressure).toBeCloseTo(0.665, 5);
    expect(rows[0]!.temperature).toBe('WARM');
  });

  it('decays into COLD when pressure drops below 0.3', () => {
    // 0.3 * (1 - 0.1) = 0.27 → COLD
    upsertPressureScore(db, makeScore({
      file_path: 'cooling.ts', project: 'p', raw_pressure: 0.3, temperature: 'WARM', decay_rate: 0.1,
    }));

    decayAllScores(db, 'p');

    const rows = getPressureScores(db, 'p');
    expect(rows[0]!.raw_pressure).toBeCloseTo(0.27, 5);
    expect(rows[0]!.temperature).toBe('COLD');
  });

  it('filters by project when specified', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'alpha', raw_pressure: 1.0, decay_rate: 0.1 }));
    upsertPressureScore(db, makeScore({ file_path: 'b.ts', project: 'beta', raw_pressure: 1.0, decay_rate: 0.1 }));

    const changed = decayAllScores(db, 'alpha');
    expect(changed).toBe(1);

    // Alpha decayed, beta untouched
    const alpha = getPressureScores(db, 'alpha');
    const beta = getPressureScores(db, 'beta');
    expect(alpha[0]!.raw_pressure).toBeCloseTo(0.9, 5);
    expect(beta[0]!.raw_pressure).toBe(1.0);
  });

  it('decays all scores when no project filter', () => {
    upsertPressureScore(db, makeScore({ file_path: 'a.ts', project: 'alpha', raw_pressure: 1.0, decay_rate: 0.1 }));
    upsertPressureScore(db, makeScore({ file_path: 'b.ts', project: 'beta', raw_pressure: 1.0, decay_rate: 0.1 }));

    const changed = decayAllScores(db);
    expect(changed).toBe(2);
  });

  it('returns 0 when no scores exist', () => {
    expect(decayAllScores(db)).toBe(0);
  });
});
