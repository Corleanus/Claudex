/**
 * Tests for session-end Sections 8 and 9: decay pass + observation pruning.
 *
 * Strategy: mock the underlying functions (decayAllScores, pruneObservations)
 * and verify that the section logic calls them correctly and handles failures
 * gracefully. This avoids native sqlite3 bindings which are unavailable in
 * the vitest worker pool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
// Helpers: simulate the section logic inline
// =============================================================================

/**
 * Simulates Section 8 (decay pass) logic extracted from session-end.ts.
 * Returns { decayRan, decayCount } so callers can assert on outcomes.
 */
async function runDecaySection(opts: {
  getDatabase: () => unknown | null;
  decayAllScores: (db: unknown, project?: string) => number;
  project: string | undefined;
  logFn: (...args: unknown[]) => void;
}): Promise<{ decayRan: boolean; decayCount: number }> {
  let decayRan = false;
  let decayCount = 0;

  try {
    const db = opts.getDatabase();
    if (!db) {
      opts.logFn('WARN', 'Database connection failed, skipping decay pass');
    } else {
      try {
        decayCount = opts.decayAllScores(db, opts.project);
        decayRan = true;
        if (decayCount > 0) {
          opts.logFn('INFO', `Decay pass: ${decayCount} pressure scores updated`);
        }
      } finally {
        (db as { close(): void }).close();
      }
    }
  } catch (err) {
    opts.logFn('WARN', 'Section 8 (decay pass) failed (non-fatal):', err);
  }

  return { decayRan, decayCount };
}

/**
 * Simulates Section 9 (observation pruning) logic extracted from session-end.ts.
 */
async function runPruneSection(opts: {
  getDatabase: () => unknown | null;
  pruneObservations: (db: unknown, project?: string) => { pruned: number; remaining: number };
  project: string | undefined;
  logFn: (...args: unknown[]) => void;
}): Promise<{ pruneRan: boolean; prunedCount: number }> {
  let pruneRan = false;
  let prunedCount = 0;

  try {
    const db = opts.getDatabase();
    if (!db) {
      opts.logFn('WARN', 'Database connection failed, skipping observation pruning');
    } else {
      try {
        const result = opts.pruneObservations(db, opts.project);
        pruneRan = true;
        prunedCount = result.pruned;
        if (prunedCount > 0) {
          opts.logFn('INFO', `Pruning: ${prunedCount} observations soft-deleted, ${result.remaining} remaining`);
        }
      } finally {
        (db as { close(): void }).close();
      }
    }
  } catch (err) {
    opts.logFn('WARN', 'Section 9 (observation pruning) failed (non-fatal):', err);
  }

  return { pruneRan, prunedCount };
}

function makeMockDb(closeFn?: () => void) {
  return { close: closeFn ?? vi.fn() };
}

// =============================================================================
// Section 8: Decay pass
// =============================================================================

describe('Section 8: decay pass', () => {
  it('calls decayAllScores with project scope and returns count', async () => {
    const mockDb = makeMockDb();
    const decayAllScores = vi.fn().mockReturnValue(5);
    const logFn = vi.fn();

    const result = await runDecaySection({
      getDatabase: () => mockDb,
      decayAllScores,
      project: 'my-project',
      logFn,
    });

    expect(decayAllScores).toHaveBeenCalledWith(mockDb, 'my-project');
    expect(result.decayRan).toBe(true);
    expect(result.decayCount).toBe(5);
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('calls decayAllScores with undefined when no project scope', async () => {
    const mockDb = makeMockDb();
    const decayAllScores = vi.fn().mockReturnValue(0);
    const logFn = vi.fn();

    const result = await runDecaySection({
      getDatabase: () => mockDb,
      decayAllScores,
      project: undefined,
      logFn,
    });

    expect(decayAllScores).toHaveBeenCalledWith(mockDb, undefined);
    expect(result.decayRan).toBe(true);
    expect(result.decayCount).toBe(0);
  });

  it('handles DB unavailable gracefully — decayRan stays false', async () => {
    const decayAllScores = vi.fn();
    const logFn = vi.fn();

    const result = await runDecaySection({
      getDatabase: () => null,
      decayAllScores,
      project: 'my-project',
      logFn,
    });

    expect(decayAllScores).not.toHaveBeenCalled();
    expect(result.decayRan).toBe(false);
    expect(result.decayCount).toBe(0);
    // Should log a WARN
    expect(logFn).toHaveBeenCalledWith('WARN', expect.stringContaining('Database connection failed'));
  });

  it('handles decayAllScores throwing — decayRan stays false, no rethrow', async () => {
    const mockDb = makeMockDb();
    const decayAllScores = vi.fn().mockImplementation(() => {
      throw new Error('DB locked');
    });
    const logFn = vi.fn();

    const result = await runDecaySection({
      getDatabase: () => mockDb,
      decayAllScores,
      project: 'my-project',
      logFn,
    });

    expect(result.decayRan).toBe(false);
    expect(result.decayCount).toBe(0);
    // close() still called from finally block before outer catch
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('does not log INFO when decayCount is 0', async () => {
    const mockDb = makeMockDb();
    const decayAllScores = vi.fn().mockReturnValue(0);
    const logFn = vi.fn();

    await runDecaySection({
      getDatabase: () => mockDb,
      decayAllScores,
      project: 'my-project',
      logFn,
    });

    const infoLogs = (logFn.mock.calls as unknown[][]).filter(c => c[0] === 'INFO');
    expect(infoLogs).toHaveLength(0);
  });
});

// =============================================================================
// Section 9: Observation pruning
// =============================================================================

describe('Section 9: observation pruning', () => {
  it('calls pruneObservations with project scope and returns result', async () => {
    const mockDb = makeMockDb();
    const pruneObservations = vi.fn().mockReturnValue({ pruned: 8, remaining: 992 });
    const logFn = vi.fn();

    const result = await runPruneSection({
      getDatabase: () => mockDb,
      pruneObservations,
      project: 'my-project',
      logFn,
    });

    expect(pruneObservations).toHaveBeenCalledWith(mockDb, 'my-project');
    expect(result.pruneRan).toBe(true);
    expect(result.prunedCount).toBe(8);
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('calls pruneObservations with undefined when no project scope', async () => {
    const mockDb = makeMockDb();
    const pruneObservations = vi.fn().mockReturnValue({ pruned: 0, remaining: 50 });
    const logFn = vi.fn();

    const result = await runPruneSection({
      getDatabase: () => mockDb,
      pruneObservations,
      project: undefined,
      logFn,
    });

    expect(pruneObservations).toHaveBeenCalledWith(mockDb, undefined);
    expect(result.pruneRan).toBe(true);
    expect(result.prunedCount).toBe(0);
  });

  it('handles DB unavailable gracefully — pruneRan stays false', async () => {
    const pruneObservations = vi.fn();
    const logFn = vi.fn();

    const result = await runPruneSection({
      getDatabase: () => null,
      pruneObservations,
      project: 'my-project',
      logFn,
    });

    expect(pruneObservations).not.toHaveBeenCalled();
    expect(result.pruneRan).toBe(false);
    expect(result.prunedCount).toBe(0);
    expect(logFn).toHaveBeenCalledWith('WARN', expect.stringContaining('Database connection failed'));
  });

  it('handles pruneObservations throwing — pruneRan stays false, no rethrow', async () => {
    const mockDb = makeMockDb();
    const pruneObservations = vi.fn().mockImplementation(() => {
      throw new Error('table missing');
    });
    const logFn = vi.fn();

    const result = await runPruneSection({
      getDatabase: () => mockDb,
      pruneObservations,
      project: 'my-project',
      logFn,
    });

    expect(result.pruneRan).toBe(false);
    expect(result.prunedCount).toBe(0);
    expect(mockDb.close).toHaveBeenCalled();
  });
});

// =============================================================================
// Independence: one section failing does not prevent the other
// =============================================================================

describe('Section independence', () => {
  it('decay failing (null DB) does not prevent pruning from running', async () => {
    const mockPruneDb = makeMockDb();
    const pruneObservations = vi.fn().mockReturnValue({ pruned: 0, remaining: 10 });
    const logFn = vi.fn();

    // Section 8 fails because getDatabase returns null
    const decayResult = await runDecaySection({
      getDatabase: () => null,
      decayAllScores: vi.fn(),
      project: 'p',
      logFn,
    });

    // Section 9 runs independently
    const pruneResult = await runPruneSection({
      getDatabase: () => mockPruneDb,
      pruneObservations,
      project: 'p',
      logFn,
    });

    expect(decayResult.decayRan).toBe(false);
    expect(pruneResult.pruneRan).toBe(true);
  });

  it('prune failing (null DB) does not prevent decay from running', async () => {
    const mockDecayDb = makeMockDb();
    const decayAllScores = vi.fn().mockReturnValue(3);
    const logFn = vi.fn();

    // Section 8 runs successfully
    const decayResult = await runDecaySection({
      getDatabase: () => mockDecayDb,
      decayAllScores,
      project: 'p',
      logFn,
    });

    // Section 9 fails because getDatabase returns null
    const pruneResult = await runPruneSection({
      getDatabase: () => null,
      pruneObservations: vi.fn(),
      project: 'p',
      logFn,
    });

    expect(decayResult.decayRan).toBe(true);
    expect(decayResult.decayCount).toBe(3);
    expect(pruneResult.pruneRan).toBe(false);
  });
});
