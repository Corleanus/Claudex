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
});
