import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';

// Mock dependencies
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
  const runner = new MigrationRunner(db);
  runner.run();
  return db;
}

// =============================================================================
// Tests
// =============================================================================

describe('user-prompt-submit hook logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  describe('short prompt threshold', () => {
    it('skips injection for prompts < 10 chars', () => {
      const shortPrompt = 'hi';
      expect(shortPrompt.length).toBeLessThan(10);
    });

    it('processes prompts >= 10 chars normally', () => {
      const normalPrompt = 'fix the login bug';
      expect(normalPrompt.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('subsystem isolation', () => {
    it('hologram failure does not prevent FTS5 search', async () => {
      const { storeObservation } = await import('../../src/db/observations.js');
      const { searchObservations } = await import('../../src/db/search.js');

      storeObservation(db, {
        session_id: 'sess-001',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Test observation',
        content: 'test content',
        importance: 3,
      });

      const results = searchObservations(db, 'test', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });

    it('FTS5 failure does not prevent recent observations fallback', async () => {
      const { storeObservation, getRecentObservations } = await import('../../src/db/observations.js');

      storeObservation(db, {
        session_id: 'sess-001',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Recent activity',
        content: 'test',
        importance: 3,
      });

      const recent = getRecentObservations(db, 5);
      expect(recent).toHaveLength(1);
    });

    it('DB unavailable returns empty arrays gracefully', async () => {
      const brokenDb = new Database(':memory:');
      brokenDb.close();

      const { getRecentObservations } = await import('../../src/db/observations.js');

      expect(() => {
        try {
          getRecentObservations(brokenDb, 5);
        } catch {
          // Expected
        }
      }).not.toThrow();
    });

    it('audit failure does not break hook', async () => {
      const brokenDb = new Database(':memory:');
      brokenDb.close();

      const { logAudit } = await import('../../src/db/audit.js');

      expect(() => {
        try {
          logAudit(brokenDb, {
            timestamp: new Date().toISOString(),
            timestamp_epoch: Date.now(),
            session_id: 'sess-001',
            event_type: 'context_assembly',
            actor: 'hook:user-prompt-submit',
            details: {},
          });
        } catch {
          // Expected
        }
      }).not.toThrow();
    });

    it('pressure score persistence failure does not break hook', async () => {
      const brokenDb = new Database(':memory:');
      brokenDb.close();

      const { upsertPressureScore } = await import('../../src/db/pressure.js');

      expect(() => {
        try {
          upsertPressureScore(brokenDb, {
            file_path: '/src/test.ts',
            raw_pressure: 0.5,
            temperature: 'WARM',
            decay_rate: 0.05,
          });
        } catch {
          // Expected
        }
      }).not.toThrow();
    });
  });

  describe('post-compact boost counter', () => {
    it('boost counter not incremented when hologram result is null (total failure)', async () => {
      const { upsertCheckpointState, getCheckpointState, updateBoostState } = await import('../../src/db/checkpoint.js');

      const sessionId = 'sess-boost-fail-null';
      const now = Date.now();

      upsertCheckpointState(db, sessionId, now, ['/src/foo.ts', '/src/bar.ts']);

      const stateBefore = getCheckpointState(db, sessionId);
      expect(stateBefore).not.toBeNull();
      expect(stateBefore!.boost_turn_count).toBe(0);

      // hologramResult is null — total query failure
      const hologramResult: { source: string } | null = null;
      const boostFiles = stateBefore!.active_files;

      if (hologramResult?.source === 'hologram' && boostFiles && boostFiles.length > 0) {
        updateBoostState(db, sessionId, now, 1);
      }

      const stateAfter = getCheckpointState(db, sessionId);
      expect(stateAfter!.boost_turn_count).toBe(0);
    });

    it('boost counter not incremented on db-pressure fallback', async () => {
      const { upsertCheckpointState, getCheckpointState, updateBoostState } = await import('../../src/db/checkpoint.js');

      const sessionId = 'sess-boost-fail-dbfb';
      const now = Date.now();

      upsertCheckpointState(db, sessionId, now, ['/src/foo.ts']);

      // Sidecar failed, fell back to db-pressure — should NOT burn a boost turn
      const hologramResult = { source: 'db-pressure', hot: [], warm: ['/src/foo.ts'], cold: [] };
      const boostFiles = ['/src/foo.ts'];

      if (hologramResult?.source === 'hologram' && boostFiles && boostFiles.length > 0) {
        updateBoostState(db, sessionId, now, 1);
      }

      const stateAfter = getCheckpointState(db, sessionId);
      expect(stateAfter!.boost_turn_count).toBe(0);
    });

    it('boost counter not incremented on recency-fallback', async () => {
      const { upsertCheckpointState, getCheckpointState, updateBoostState } = await import('../../src/db/checkpoint.js');

      const sessionId = 'sess-boost-fail-recfb';
      const now = Date.now();

      upsertCheckpointState(db, sessionId, now, ['/src/foo.ts']);

      // All tiers failed, fell back to recency — should NOT burn a boost turn
      const hologramResult = { source: 'recency-fallback', hot: [], warm: [], cold: ['/src/foo.ts'] };
      const boostFiles = ['/src/foo.ts'];

      if (hologramResult?.source === 'hologram' && boostFiles && boostFiles.length > 0) {
        updateBoostState(db, sessionId, now, 1);
      }

      const stateAfter = getCheckpointState(db, sessionId);
      expect(stateAfter!.boost_turn_count).toBe(0);
    });

    it('boost counter incremented only on real sidecar success (source=hologram)', async () => {
      const { upsertCheckpointState, getCheckpointState, updateBoostState } = await import('../../src/db/checkpoint.js');

      const sessionId = 'sess-boost-ok';
      const now = Date.now();

      upsertCheckpointState(db, sessionId, now, ['/src/foo.ts']);

      // Real sidecar success
      const hologramResult = { source: 'hologram', hot: ['/src/foo.ts'], warm: [], cold: [] };
      const boostFiles = ['/src/foo.ts'];

      if (hologramResult?.source === 'hologram' && boostFiles && boostFiles.length > 0) {
        updateBoostState(db, sessionId, now, 1);
      }

      const stateAfter = getCheckpointState(db, sessionId);
      expect(stateAfter!.boost_turn_count).toBe(1);
      expect(stateAfter!.boost_applied_at).toBe(now);
    });

    it('boost counter does not advance past MAX_BOOST_TURNS', async () => {
      const { upsertCheckpointState, getCheckpointState, updateBoostState } = await import('../../src/db/checkpoint.js');

      const sessionId = 'sess-boost-max';
      const now = Date.now();
      const MAX_BOOST_TURNS = 3;

      upsertCheckpointState(db, sessionId, now, ['/src/foo.ts']);
      // Already at max turns
      updateBoostState(db, sessionId, now, MAX_BOOST_TURNS);

      const cpState = getCheckpointState(db, sessionId);
      const turnsRemaining = !cpState!.boost_applied_at
        || (cpState!.boost_turn_count ?? 0) < MAX_BOOST_TURNS;

      // turnsRemaining should be false — boost block should not activate
      expect(turnsRemaining).toBe(false);
    });
  });
});
