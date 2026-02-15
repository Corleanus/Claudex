/**
 * Claudex v2 — Tests: Flush Trigger
 *
 * Tests the flush orchestration in src/wrapper/flush-trigger.ts:
 * isCooldownActive, executeFlush, resetCooldown.
 *
 * Uses real SQLite in-memory DB for reasoning/pressure CRUD,
 * mocks hologram sidecar and flat-file-mirror modules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import type { PressureScore, Scope } from '../../src/shared/types.js';

// Mock logger
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock hologram launcher — sidecar not running by default
vi.mock('../../src/hologram/launcher.js', () => ({
  SidecarManager: vi.fn().mockImplementation(() => ({
    getPort: vi.fn().mockReturnValue(null),
  })),
}));

// Mock hologram protocol
vi.mock('../../src/hologram/protocol.js', () => ({
  ProtocolHandler: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ type: 'result', id: 'test', payload: {} }),
  })),
  buildRequest: vi.fn().mockReturnValue({
    id: 'test-req',
    type: 'query',
    payload: { prompt: '__rescore__' },
  }),
}));

// Mock config loader
vi.mock('../../src/shared/config.js', () => ({
  loadConfig: vi.fn().mockReturnValue({
    hologram: { timeout_ms: 2000 },
  }),
}));

// Mock flat-file-mirror
vi.mock('../../src/lib/flat-file-mirror.js', () => ({
  mirrorReasoning: vi.fn(),
  mirrorPressureScores: vi.fn(),
  mirrorObservation: vi.fn(),
  mirrorConsensus: vi.fn(),
  sanitizeFilename: vi.fn().mockReturnValue('test-file'),
}));

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (id INTEGER PRIMARY KEY, version INTEGER UNIQUE NOT NULL, applied_at TEXT NOT NULL)`);
  const runner = new MigrationRunner(db);
  migration_1(runner);
  migration_2(runner);
  migration_3(runner);
  migration_4(runner);
  return db;
}

const TEST_SCOPE: Scope = { type: 'global' };
const TEST_SESSION_ID = 'test-session-001';

describe('isCooldownActive', () => {
  let isCooldownActive: typeof import('../../src/wrapper/flush-trigger.js').isCooldownActive;
  let resetCooldown: typeof import('../../src/wrapper/flush-trigger.js').resetCooldown;

  beforeEach(async () => {
    const mod = await import('../../src/wrapper/flush-trigger.js');
    isCooldownActive = mod.isCooldownActive;
    resetCooldown = mod.resetCooldown;
    resetCooldown();
  });

  afterEach(() => {
    resetCooldown();
  });

  it('returns false initially (never flushed)', () => {
    // lastFlushEpoch is 0, Date.now() - 0 is always > any reasonable cooldownMs
    expect(isCooldownActive(30000)).toBe(false);
  });

  it('returns true right after a flush', async () => {
    const mod = await import('../../src/wrapper/flush-trigger.js');
    const db = setupDb();

    // Execute a flush to set lastFlushEpoch to Date.now()
    await mod.executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
    });

    // Cooldown should be active now (30s cooldown, just flushed)
    expect(isCooldownActive(30000)).toBe(true);

    db.close();
    resetCooldown();
  });
});

describe('resetCooldown', () => {
  let resetCooldown: typeof import('../../src/wrapper/flush-trigger.js').resetCooldown;
  let isCooldownActive: typeof import('../../src/wrapper/flush-trigger.js').isCooldownActive;
  let executeFlush: typeof import('../../src/wrapper/flush-trigger.js').executeFlush;

  beforeEach(async () => {
    const mod = await import('../../src/wrapper/flush-trigger.js');
    resetCooldown = mod.resetCooldown;
    isCooldownActive = mod.isCooldownActive;
    executeFlush = mod.executeFlush;
    resetCooldown();
  });

  afterEach(() => {
    resetCooldown();
  });

  it('resets the cooldown timer', async () => {
    const db = setupDb();

    // Flush to activate cooldown
    await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
    });

    expect(isCooldownActive(30000)).toBe(true);

    // Reset
    resetCooldown();

    // Now cooldown should be inactive
    expect(isCooldownActive(30000)).toBe(false);

    db.close();
  });
});

describe('executeFlush', () => {
  let executeFlush: typeof import('../../src/wrapper/flush-trigger.js').executeFlush;
  let resetCooldown: typeof import('../../src/wrapper/flush-trigger.js').resetCooldown;
  let isCooldownActive: typeof import('../../src/wrapper/flush-trigger.js').isCooldownActive;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../src/wrapper/flush-trigger.js');
    executeFlush = mod.executeFlush;
    resetCooldown = mod.resetCooldown;
    isCooldownActive = mod.isCooldownActive;
    resetCooldown();
  });

  afterEach(() => {
    resetCooldown();
  });

  it('captures reasoning when reasoningText provided (verify DB insert)', async () => {
    const db = setupDb();

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      reasoningText: 'This is a test reasoning chain about architecture decisions.',
    });

    expect(result.reasoningCaptured).toBe(1);

    // Verify the row was actually inserted in the DB
    const row = db.prepare('SELECT * FROM reasoning_chains WHERE session_id = ?').get(TEST_SESSION_ID) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!['reasoning']).toBe('This is a test reasoning chain about architecture decisions.');
    expect(row!['trigger']).toBe('pre_compact');

    db.close();
  });

  it('skips reasoning when no reasoningText', async () => {
    const db = setupDb();

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
    });

    expect(result.reasoningCaptured).toBe(0);

    // No rows should exist
    const row = db.prepare('SELECT * FROM reasoning_chains WHERE session_id = ?').get(TEST_SESSION_ID);
    expect(row).toBeUndefined();

    db.close();
  });

  it('persists pressure scores to DB', async () => {
    const db = setupDb();

    const scores: PressureScore[] = [
      {
        file_path: '/src/main.ts',
        project: '__global__',
        raw_pressure: 0.85,
        temperature: 'HOT',
        decay_rate: 0.05,
      },
      {
        file_path: '/src/utils.ts',
        project: '__global__',
        raw_pressure: 0.45,
        temperature: 'WARM',
        decay_rate: 0.05,
      },
    ];

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      pressureScores: scores,
    });

    expect(result.pressureScoresFlushed).toBe(2);

    // Verify DB rows
    const rows = db.prepare('SELECT * FROM pressure_scores ORDER BY raw_pressure DESC').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!['file_path']).toBe('/src/main.ts');
    expect(rows[1]!['file_path']).toBe('/src/utils.ts');

    db.close();
  });

  it('writes flat-file mirror for reasoning', async () => {
    const { mirrorReasoning } = await import('../../src/lib/flat-file-mirror.js');
    const db = setupDb();

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      reasoningText: 'Mirror test reasoning.',
    });

    expect(result.mirrorFilesWritten).toBeGreaterThanOrEqual(1);
    expect(mirrorReasoning).toHaveBeenCalledTimes(1);

    db.close();
  });

  it('writes flat-file mirror for pressure scores', async () => {
    const { mirrorPressureScores } = await import('../../src/lib/flat-file-mirror.js');
    const db = setupDb();

    const scores: PressureScore[] = [
      {
        file_path: '/src/app.ts',
        project: '__global__',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      },
    ];

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      pressureScores: scores,
    });

    expect(mirrorPressureScores).toHaveBeenCalledTimes(1);
    expect(mirrorPressureScores).toHaveBeenCalledWith(scores, TEST_SCOPE);
    expect(result.mirrorFilesWritten).toBeGreaterThanOrEqual(1);

    db.close();
  });

  it('returns correct FlushResult with counts', async () => {
    const db = setupDb();

    const scores: PressureScore[] = [
      {
        file_path: '/src/a.ts',
        project: '__global__',
        raw_pressure: 0.7,
        temperature: 'HOT',
        decay_rate: 0.05,
      },
      {
        file_path: '/src/b.ts',
        project: '__global__',
        raw_pressure: 0.3,
        temperature: 'WARM',
        decay_rate: 0.05,
      },
      {
        file_path: '/src/c.ts',
        project: '__global__',
        raw_pressure: 0.1,
        temperature: 'COLD',
        decay_rate: 0.05,
      },
    ];

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      reasoningText: 'Test reasoning for counts.',
      pressureScores: scores,
    });

    expect(result.reasoningCaptured).toBe(1);
    expect(result.pressureScoresFlushed).toBe(3);
    // 1 reasoning mirror + 1 pressure mirror = 2
    expect(result.mirrorFilesWritten).toBe(2);
    // hologram sidecar not running, but DB has HOT pressure scores
    // so rescoreWithFallback returns 'db-pressure' which counts as rescored
    expect(result.hologramRescored).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    db.close();
  });

  it('returns partial result if one subsystem fails', async () => {
    const db = setupDb();

    // Make reasoning insert fail by dropping the reasoning_chains table.
    // The insertReasoning function catches errors internally and returns { id: -1 },
    // which means the id check (inserted.id > 0) in flush-trigger will fail
    // and reasoningCaptured stays 0. Pressure should still succeed.
    db.exec('DROP TABLE reasoning_chains');

    const scores: PressureScore[] = [
      {
        file_path: '/src/still-works.ts',
        project: '__global__',
        raw_pressure: 0.5,
        temperature: 'WARM',
        decay_rate: 0.05,
      },
    ];

    const result = await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
      reasoningText: 'This reasoning should fail to insert.',
      pressureScores: scores,
    });

    // Reasoning should fail (table dropped → insertReasoning returns { id: -1 })
    expect(result.reasoningCaptured).toBe(0);
    // Pressure should succeed
    expect(result.pressureScoresFlushed).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    db.close();
  });

  it('updates cooldown timer after execution', async () => {
    const db = setupDb();

    // Cooldown should be inactive before flush
    expect(isCooldownActive(30000)).toBe(false);

    await executeFlush({
      db,
      sessionId: TEST_SESSION_ID,
      scope: TEST_SCOPE,
    });

    // Cooldown should be active after flush
    expect(isCooldownActive(30000)).toBe(true);

    db.close();
  });
});
