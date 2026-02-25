import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { computeEI, getHalfLife, isImmune, pruneObservations } from '../../src/lib/decay-engine.js';

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
// getHalfLife
// =============================================================================

describe('getHalfLife', () => {
  it('importance 1 → 7 days', () => {
    expect(getHalfLife(1)).toBe(7);
  });

  it('importance 2 → 14 days', () => {
    expect(getHalfLife(2)).toBe(14);
  });

  it('importance 3 → 60 days', () => {
    expect(getHalfLife(3)).toBe(60);
  });

  it('importance 4 → 90 days', () => {
    expect(getHalfLife(4)).toBe(90);
  });

  it('importance 5 → 365 days', () => {
    expect(getHalfLife(5)).toBe(365);
  });

  it('clamps below 1 to 7 days', () => {
    expect(getHalfLife(0)).toBe(7);
  });

  it('clamps above 5 to 365 days', () => {
    expect(getHalfLife(6)).toBe(365);
  });
});

// =============================================================================
// computeEI
// =============================================================================

describe('computeEI', () => {
  it('critical importance produces highest score (vs low importance)', () => {
    const critical = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const low = computeEI({ importance: 1, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    expect(critical).toBeGreaterThan(low);
  });

  it('low importance produces lowest score (vs critical)', () => {
    const low = computeEI({ importance: 1, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const critical = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    expect(low).toBeLessThan(critical);
  });

  it('access boost: accessCount=5 scores higher than accessCount=0', () => {
    const base = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const boosted = computeEI({ importance: 3, accessCount: 5, daysSinceAccess: 0, coOccurrences: 0 });
    expect(boosted).toBeGreaterThan(base);
  });

  it('decay over time: 60 days scores lower than 0 days', () => {
    const fresh = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const aged = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 60, coOccurrences: 0 });
    expect(aged).toBeLessThan(fresh);
  });

  it('connectivity bonus: coOccurrences=5 scores higher than coOccurrences=0', () => {
    const base = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const connected = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 5 });
    expect(connected).toBeGreaterThan(base);
  });

  it('coOccurrences capped at 5 (coOccurrences=10 equals coOccurrences=5)', () => {
    const at5 = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 5 });
    const at10 = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 10 });
    expect(at5).toBeCloseTo(at10, 10);
  });

  it('all factors combined — critical + high access + fresh + well-connected', () => {
    const score = computeEI({ importance: 5, accessCount: 10, daysSinceAccess: 0, coOccurrences: 5 });
    // baseWeight=1.0, accessFactor=ln(11)≈2.398, decayFactor=1.0, connectivityBonus=1.5
    expect(score).toBeGreaterThan(1.0);
    expect(score).toBeGreaterThan(2.0);
  });

  it('importance 5 fresh has EI = 1.0 × max(1,ln(1)) × 1.0 × 1.0 = 1.0', () => {
    const score = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    // baseWeight=1.0, accessFactor=max(1,ln(1))=max(1,0)=1, decayFactor=1, connectivity=1
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('at half-life: decayFactor = 0.5 for importance 3 at 60 days, no access boost', () => {
    const score = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 60, coOccurrences: 0 });
    // baseWeight=0.6, accessFactor=1, decayFactor=0.5, connectivity=1
    expect(score).toBeCloseTo(0.3, 5);
  });
});

// =============================================================================
// isImmune
// =============================================================================

describe('isImmune', () => {
  const IMMUNITY_WINDOW_MS = 180 * 86400 * 1000;

  it('critical importance (5) is always immune', () => {
    expect(isImmune(5, 0, null)).toBe(true);
  });

  it('importance > 5 is immune (clamped critical)', () => {
    expect(isImmune(6, 0, null)).toBe(true);
  });

  it('accessCount >= 3 with recent access is immune', () => {
    const recentEpoch = Date.now() - 10 * 86400 * 1000; // 10 days ago
    expect(isImmune(3, 3, recentEpoch)).toBe(true);
  });

  it('accessCount >= 3 within 180-day window is immune', () => {
    const withinWindow = Date.now() - 170 * 86400 * 1000; // 170 days ago — within 180d
    expect(isImmune(3, 3, withinWindow)).toBe(true);
  });

  it('accessCount >= 3 with stale access (> 180 days) is NOT immune', () => {
    const staleEpoch = Date.now() - 200 * 86400 * 1000; // 200 days ago
    expect(isImmune(3, 3, staleEpoch)).toBe(false);
  });

  it('accessCount >= 3 at old 90-day mark is still immune (window is now 180d)', () => {
    const ninetyOneDaysAgo = Date.now() - 91 * 86400 * 1000;
    expect(isImmune(3, 3, ninetyOneDaysAgo)).toBe(true);
  });

  it('accessCount >= 3 with null last access is NOT immune', () => {
    expect(isImmune(3, 3, null)).toBe(false);
  });

  it('low importance + low access is not immune', () => {
    expect(isImmune(1, 0, null)).toBe(false);
  });

  it('accessCount < 3 with recent access is not immune', () => {
    const recentEpoch = Date.now() - 5 * 86400 * 1000;
    expect(isImmune(2, 2, recentEpoch)).toBe(false);
  });

  it('boundary: exactly 180 days ago is NOT immune (must be strictly less than 180d)', () => {
    const exactlyAtBoundary = Date.now() - IMMUNITY_WINDOW_MS;
    // Date.now() - epoch = IMMUNITY_WINDOW_MS which is NOT < IMMUNITY_WINDOW_MS
    expect(isImmune(3, 3, exactlyAtBoundary)).toBe(false);
  });
});

// =============================================================================
// pruneObservations — integration tests with real SQLite
// =============================================================================

describe('pruneObservations', () => {
  let db: Database.Database;

  function createSchema(database: Database.Database): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL DEFAULT 'test-session',
        project TEXT,
        timestamp TEXT NOT NULL DEFAULT '',
        timestamp_epoch INTEGER NOT NULL,
        tool_name TEXT NOT NULL DEFAULT 'test',
        category TEXT NOT NULL DEFAULT 'decision',
        title TEXT NOT NULL DEFAULT '',
        content TEXT,
        facts TEXT,
        files_read TEXT,
        files_modified TEXT,
        importance INTEGER NOT NULL DEFAULT 1,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_epoch INTEGER,
        created_at TEXT,
        created_at_epoch INTEGER,
        deleted_at_epoch INTEGER
      )
    `);
  }

  function insertObs(
    database: Database.Database,
    overrides: Partial<{
      importance: number;
      access_count: number;
      last_accessed_at_epoch: number | null;
      timestamp_epoch: number;
      files_modified: string | null;
      files_read: string | null;
      deleted_at_epoch: number | null;
      project: string | null;
    }> = {},
  ): number {
    const now = Date.now();
    const result = database.prepare(`
      INSERT INTO observations (
        timestamp_epoch, importance, access_count, last_accessed_at_epoch,
        files_modified, files_read, deleted_at_epoch, project
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      overrides.timestamp_epoch ?? now,
      overrides.importance ?? 1,
      overrides.access_count ?? 0,
      overrides.last_accessed_at_epoch ?? null,
      overrides.files_modified ?? null,
      overrides.files_read ?? null,
      overrides.deleted_at_epoch ?? null,
      overrides.project ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  it('does not prune when below threshold (1000)', () => {
    // Insert 500 observations — well below threshold
    for (let i = 0; i < 500; i++) {
      insertObs(db);
    }
    const result = pruneObservations(db);
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(500);
  });

  it('prunes up to 50 lowest-EI observations when above threshold', () => {
    const now = Date.now();
    // Insert 1010 low-importance observations
    for (let i = 0; i < 1010; i++) {
      insertObs(db, {
        importance: 1,
        timestamp_epoch: now - 30 * 86400000, // 30 days old
      });
    }
    const result = pruneObservations(db);
    expect(result.pruned).toBe(50);
    expect(result.remaining).toBe(960);
  });

  it('does not prune immune observations (importance 5)', () => {
    const now = Date.now();
    // Insert 1010 critical observations — all immune
    for (let i = 0; i < 1010; i++) {
      insertObs(db, { importance: 5, timestamp_epoch: now });
    }
    const result = pruneObservations(db);
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(1010);
  });

  it('does not prune immune observations (high access + recent)', () => {
    const now = Date.now();
    // Insert 1010 frequently-accessed recent observations
    for (let i = 0; i < 1010; i++) {
      insertObs(db, {
        importance: 3,
        access_count: 5,
        last_accessed_at_epoch: now - 10 * 86400000, // 10 days ago
        timestamp_epoch: now,
      });
    }
    const result = pruneObservations(db);
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(1010);
  });

  it('co-occurrence self-join query returns correct counts for shared files', () => {
    // Test the co-occurrence SQL logic directly: observations sharing
    // files_modified should be counted as co-occurring.
    const now = Date.now();
    const sharedFile = JSON.stringify(['/src/shared.ts']);
    const otherFile = JSON.stringify(['/src/other.ts']);

    // 3 observations share /src/shared.ts
    insertObs(db, { importance: 3, timestamp_epoch: now, files_modified: sharedFile });
    insertObs(db, { importance: 3, timestamp_epoch: now, files_modified: sharedFile });
    insertObs(db, { importance: 3, timestamp_epoch: now, files_modified: sharedFile });
    // 1 observation has a different file
    insertObs(db, { importance: 3, timestamp_epoch: now, files_modified: otherFile });
    // 1 observation has no files
    insertObs(db, { importance: 3, timestamp_epoch: now, files_modified: null });

    const coRows = db.prepare(`
      SELECT o1.id, COUNT(DISTINCT o2.id) as co_count
      FROM observations o1
      JOIN observations o2 ON o1.id != o2.id AND o2.deleted_at_epoch IS NULL
      WHERE o1.deleted_at_epoch IS NULL
      AND EXISTS (
        SELECT 1 FROM json_each(o1.files_modified) fm1
        JOIN json_each(o2.files_modified) fm2 ON fm1.value = fm2.value
      )
      GROUP BY o1.id
    `).all() as { id: number; co_count: number }[];

    // Only the 3 shared-file observations should appear, each with co_count=2
    expect(coRows.length).toBe(3);
    for (const row of coRows) {
      expect(row.co_count).toBe(2);
    }
  });

  it('co-occurrence falls back gracefully when files_modified is NULL', () => {
    const now = Date.now();
    // Insert 1010 observations with no files_modified — co-occurrence query
    // should still work (those rows simply won't appear in the self-join)
    for (let i = 0; i < 1010; i++) {
      insertObs(db, {
        importance: 1,
        timestamp_epoch: now - 30 * 86400000,
        files_modified: null,
      });
    }
    const result = pruneObservations(db);
    expect(result.pruned).toBe(50);
    expect(result.remaining).toBe(960);
  });

  it('returns safe default on DB error', () => {
    // Close the database to force an error
    db.close();
    const result = pruneObservations(db);
    expect(result.pruned).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('respects project filter', () => {
    const now = Date.now();
    // Insert 600 for project-a and 600 for project-b
    for (let i = 0; i < 600; i++) {
      insertObs(db, { importance: 1, timestamp_epoch: now - 30 * 86400000, project: 'project-a' });
    }
    for (let i = 0; i < 600; i++) {
      insertObs(db, { importance: 1, timestamp_epoch: now - 30 * 86400000, project: 'project-b' });
    }

    // Each project has 600 < 1000 threshold — no pruning per-project
    const resultA = pruneObservations(db, 'project-a');
    expect(resultA.pruned).toBe(0);
    expect(resultA.remaining).toBe(600);

    // Without project filter: 1200 > 1000 — should prune
    const resultAll = pruneObservations(db);
    expect(resultAll.pruned).toBe(50);
    expect(resultAll.remaining).toBe(1150);
  });
});
