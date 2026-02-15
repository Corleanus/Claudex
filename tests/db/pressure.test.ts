import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import {
  upsertPressureScore,
  getPressureScores,
  getHotFiles,
  getWarmFiles,
  decayAllScores,
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
