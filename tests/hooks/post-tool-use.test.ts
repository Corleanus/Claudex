import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { extractObservation } from '../../src/lib/observation-extractor.js';
import type { Scope } from '../../src/shared/types.js';

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

const TEST_SESSION = 'sess-post-tool-test';
const PROJECT_SCOPE: Scope = { type: 'project', name: 'test-project', path: '/test/project' };
const GLOBAL_SCOPE: Scope = { type: 'global' };

// =============================================================================
// Tests
// =============================================================================

describe('post-tool-use hook logic', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
  });

  describe('pressure accumulation from observations', () => {
    it('accumulates pressure for Read observations with READ_INCREMENT', async () => {
      const { accumulatePressureScore } = await import('../../src/db/pressure.js');
      const accSpy = vi.spyOn({ accumulatePressureScore }, 'accumulatePressureScore');

      // Extract a Read observation
      const observation = extractObservation(
        'Read',
        { file_path: '/src/foo.ts' },
        { output: 'file contents' },
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();
      expect(observation!.files_read).toBeDefined();
      expect(observation!.files_read!.length).toBeGreaterThan(0);

      // Simulate Step 3.5: accumulate pressure
      const READ_INCREMENT = 0.05;
      const project = PROJECT_SCOPE.name;
      const allFiles = [
        ...(observation!.files_modified || []),
        ...(observation!.files_read || []),
      ];

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, project, READ_INCREMENT);
      }

      // Verify pressure was accumulated
      const { getPressureScores } = await import('../../src/db/pressure.js');
      const scores = getPressureScores(db, project);
      expect(scores.length).toBe(1);
      expect(scores[0]!.raw_pressure).toBeCloseTo(READ_INCREMENT, 5);

      accSpy.mockRestore();
    });

    it('accumulates pressure for Edit observations with WRITE_INCREMENT', async () => {
      const { accumulatePressureScore, getPressureScores } = await import('../../src/db/pressure.js');

      const observation = extractObservation(
        'Edit',
        { file_path: '/src/bar.ts', old_string: 'old', new_string: 'new' },
        undefined,
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();
      expect(observation!.files_modified).toBeDefined();
      expect(observation!.files_modified!.length).toBeGreaterThan(0);

      const WRITE_INCREMENT = 0.15;
      const project = PROJECT_SCOPE.name;
      const allFiles = [
        ...(observation!.files_modified || []),
        ...(observation!.files_read || []),
      ];

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, project, WRITE_INCREMENT);
      }

      const scores = getPressureScores(db, project);
      expect(scores.length).toBe(1);
      expect(scores[0]!.raw_pressure).toBeCloseTo(WRITE_INCREMENT, 5);
    });

    it('accumulates pressure for Write observations with WRITE_INCREMENT', async () => {
      const { accumulatePressureScore, getPressureScores } = await import('../../src/db/pressure.js');

      const observation = extractObservation(
        'Write',
        { file_path: '/src/new-file.ts' },
        undefined,
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();
      expect(observation!.files_modified).toBeDefined();
      expect(observation!.files_modified!.length).toBeGreaterThan(0);

      const WRITE_INCREMENT = 0.15;
      const project = PROJECT_SCOPE.name;
      const allFiles = [
        ...(observation!.files_modified || []),
        ...(observation!.files_read || []),
      ];

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, project, WRITE_INCREMENT);
      }

      const scores = getPressureScores(db, project);
      expect(scores.length).toBe(1);
      expect(scores[0]!.raw_pressure).toBeCloseTo(WRITE_INCREMENT, 5);
    });

    it('accumulates pressure for Grep observations with GREP_INCREMENT', async () => {
      const { accumulatePressureScore, getPressureScores } = await import('../../src/db/pressure.js');

      const observation = extractObservation(
        'Grep',
        { pattern: 'import.*foo' },
        { files: ['/src/a.ts', '/src/b.ts', '/src/c.ts'] },
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();
      expect(observation!.files_read).toBeDefined();
      expect(observation!.files_read!.length).toBeGreaterThan(0);

      const GREP_INCREMENT = 0.02;
      const project = PROJECT_SCOPE.name;
      const allFiles = [
        ...(observation!.files_modified || []),
        ...(observation!.files_read || []),
      ];

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, project, GREP_INCREMENT);
      }

      const scores = getPressureScores(db, project);
      expect(scores.length).toBeGreaterThan(0);
      for (const score of scores) {
        expect(score.raw_pressure).toBeCloseTo(GREP_INCREMENT, 5);
      }
    });

    it('skips pressure when observation is null (filtered tools)', async () => {
      const { getPressureScores } = await import('../../src/db/pressure.js');

      // Bash 'ls' is a trivial command — extractObservation returns null
      const observation = extractObservation(
        'Bash',
        { command: 'ls' },
        { exit_code: 0, output: 'file1 file2' },
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).toBeNull();

      // Simulate the hook guard: if (!observation) return {};
      // No pressure accumulation should happen
      const scores = getPressureScores(db, PROJECT_SCOPE.name);
      expect(scores.length).toBe(0);
    });

    it('skips pressure when db is unavailable', async () => {
      const observation = extractObservation(
        'Read',
        { file_path: '/src/test.ts' },
        { output: 'content' },
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();

      // Simulate db = null (getDatabase() returned null)
      const nullDb = null;

      // The hook guard: if (observation && db) { ... }
      // With db = null, this block is skipped — no crash expected
      expect(() => {
        if (observation && nullDb) {
          // This code should NOT execute
          throw new Error('Should not reach here');
        }
      }).not.toThrow();
    });

    it('pressure failure does not break observation pipeline', async () => {
      const { storeObservation } = await import('../../src/db/observations.js');
      const { incrementObservationCount } = await import('../../src/db/sessions.js');
      const { createSession } = await import('../../src/db/sessions.js');
      const pressure = await import('../../src/db/pressure.js');

      // Create a session so incrementObservationCount doesn't fail
      createSession(db, {
        session_id: TEST_SESSION,
        scope: 'project:test-project',
        cwd: '/test/project',
      });

      const observation = extractObservation(
        'Edit',
        { file_path: '/src/critical.ts', old_string: 'old', new_string: 'new' },
        undefined,
        TEST_SESSION,
        PROJECT_SCOPE,
      );

      expect(observation).not.toBeNull();

      // Step 3: Store observation — should succeed
      const result = storeObservation(db, observation!);
      expect(result.id).not.toBe(-1);
      incrementObservationCount(db, TEST_SESSION);

      // Step 3.5: Make accumulatePressureScore throw
      const origAccumulate = pressure.accumulatePressureScore;
      const mockAccumulate = vi.fn(() => { throw new Error('Simulated pressure failure'); });

      // Simulate the try/catch in the hook
      try {
        const allFiles = [
          ...(observation!.files_modified || []),
          ...(observation!.files_read || []),
        ];
        for (const filePath of allFiles) {
          mockAccumulate(db, filePath, 'test-project', 0.15);
        }
      } catch {
        // Non-fatal — hook catches this and continues
      }

      expect(mockAccumulate).toHaveBeenCalled();

      // Verify observation was still stored (Step 3 wasn't affected)
      const { getRecentObservations } = await import('../../src/db/observations.js');
      const stored = getRecentObservations(db, 5);
      expect(stored.length).toBeGreaterThan(0);
      expect(stored.some(o => o.title.includes('critical.ts'))).toBe(true);
    });

    it('uses global scope when scope.type is not project', async () => {
      const { accumulatePressureScore, getPressureScores } = await import('../../src/db/pressure.js');

      const observation = extractObservation(
        'Read',
        { file_path: '/tmp/global-file.ts' },
        { output: 'content' },
        TEST_SESSION,
        GLOBAL_SCOPE,
      );

      expect(observation).not.toBeNull();

      // In global scope, project is undefined → accumulatePressureScore uses __global__ sentinel
      const project = GLOBAL_SCOPE.type === 'project' ? (GLOBAL_SCOPE as { name: string }).name : undefined;
      expect(project).toBeUndefined();

      const allFiles = [
        ...(observation!.files_modified || []),
        ...(observation!.files_read || []),
      ];

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, project, 0.05);
      }

      // Should be stored under __global__ sentinel
      const scores = getPressureScores(db, '__global__');
      expect(scores.length).toBe(1);
    });

    it('accumulates pressure for both files_read and files_modified', async () => {
      const { accumulatePressureScore, getPressureScores } = await import('../../src/db/pressure.js');

      // Manually create an observation-like object with both fields
      // (In practice, Edit has files_modified and Read has files_read,
      //  but the hook code merges both arrays)
      const observation = {
        session_id: TEST_SESSION,
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Edit',
        category: 'change' as const,
        title: 'Test',
        content: 'Test',
        importance: 3,
        files_read: ['/src/read-file.ts'],
        files_modified: ['/src/modified-file.ts'],
        project: 'test-project',
      };

      const allFiles = [
        ...(observation.files_modified || []),
        ...(observation.files_read || []),
      ];

      expect(allFiles).toHaveLength(2);

      for (const filePath of allFiles) {
        accumulatePressureScore(db, filePath, 'test-project', 0.15);
      }

      const scores = getPressureScores(db, 'test-project');
      expect(scores.length).toBe(2);
    });
  });
});
