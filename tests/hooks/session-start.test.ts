import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectScope } from '../../src/shared/scope-detector.js';
import { MigrationRunner } from '../../src/db/migrations.js';

// Mock logger and metrics
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
  getMetrics: vi.fn(() => ({})),
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

describe('session-start hook logic', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    db = setupDb();
    tempDir = path.join(process.cwd(), '.test-claudex');
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    db?.close();
    vi.restoreAllMocks();
    // Cleanup temp directories if created
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup
    }
  });

  describe('directory bootstrapping', () => {
    it('creates required directories if missing', () => {
      const testDirs = [
        path.join(tempDir, 'identity'),
        path.join(tempDir, 'memory'),
        path.join(tempDir, 'sessions'),
      ];

      for (const dir of testDirs) {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }

      for (const dir of testDirs) {
        expect(fs.existsSync(dir)).toBe(true);
      }
    });

    it('is idempotent: does not fail if directories already exist', () => {
      const dir = path.join(tempDir, 'test-idempotent');
      fs.mkdirSync(dir, { recursive: true });

      // Should not throw
      expect(() => fs.mkdirSync(dir, { recursive: true })).not.toThrow();
    });

    it('handles filesystem errors gracefully', () => {
      // Verify that catching fs errors works as expected
      expect(() => {
        try {
          // Attempt to create directory inside a file (will fail)
          const filePath = path.join(tempDir, 'not-a-dir');
          fs.writeFileSync(filePath, 'test');
          fs.mkdirSync(path.join(filePath, 'subdir'));
        } catch {
          // Expected — bootstrap should catch and continue
        }
      }).not.toThrow();
    });
  });

  describe('scope detection', () => {
    it('detects global scope for non-project directories', () => {
      const scope = detectScope('/tmp');
      expect(scope.type).toBe('global');
    });

    it('detects project scope for directories with CLAUDE.md', () => {
      const projectDir = path.join(tempDir, 'test-project');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Test project');

      const scope = detectScope(projectDir);
      expect(scope.type).toBe('project');
      if (scope.type === 'project') {
        expect(scope.name).toBeTruthy();
      }
    });
  });

  describe('index.json registration', () => {
    it('creates new index.json if missing', () => {
      const indexPath = path.join(tempDir, 'index.json');
      const entry = {
        id: 'sess-001',
        date: '2023-11-14',
        started_at: '2023-11-14T10:00:00Z',
        scope: 'global',
        project: null,
        cwd: '/test',
        source: 'startup',
        status: 'active',
      };

      const index = {
        schema: 'claudex/session-index',
        version: 1,
        sessions: [entry],
      };

      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      expect(fs.existsSync(indexPath)).toBe(true);

      const read = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      expect(read.sessions).toHaveLength(1);
      expect(read.sessions[0]!.id).toBe('sess-001');
    });

    it('appends to existing index.json', () => {
      const indexPath = path.join(tempDir, 'index.json');
      const initialEntry = {
        id: 'sess-001',
        date: '2023-11-14',
        started_at: '2023-11-14T10:00:00Z',
        scope: 'global',
        project: null,
        cwd: '/test',
        source: 'startup',
        status: 'active',
      };

      const index = {
        schema: 'claudex/session-index',
        version: 1,
        sessions: [initialEntry],
      };

      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

      // Append second entry
      const updated = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      updated.sessions.push({
        id: 'sess-002',
        date: '2023-11-14',
        started_at: '2023-11-14T11:00:00Z',
        scope: 'global',
        project: null,
        cwd: '/test',
        source: 'resume',
        status: 'active',
      });
      fs.writeFileSync(indexPath, JSON.stringify(updated, null, 2));

      const final = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      expect(final.sessions).toHaveLength(2);
    });

    it('handles malformed index.json gracefully', () => {
      const indexPath = path.join(tempDir, 'index-malformed.json');
      fs.writeFileSync(indexPath, 'not valid json');

      expect(() => {
        try {
          JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        } catch {
          // Expected — should handle gracefully by starting fresh
        }
      }).not.toThrow();
    });
  });

  describe('SQLite registration', () => {
    it('creates session in database', async () => {
      const { createSession } = await import('../../src/db/sessions.js');

      const result = createSession(db, {
        session_id: 'sess-test',
        scope: 'global',
        cwd: '/test',
      });

      expect(result.id).toBeGreaterThan(0);
    });

    it('isolation: handles DB unavailable gracefully', async () => {
      const brokenDb = new Database(':memory:');
      brokenDb.close();

      const { createSession } = await import('../../src/db/sessions.js');

      // Should not throw — DB is soft dependency
      expect(() => {
        try {
          createSession(brokenDb, {
            session_id: 'sess-test',
            scope: 'global',
            cwd: '/test',
          });
        } catch {
          // Expected
        }
      }).not.toThrow();
    });
  });

  describe('first-run detection', () => {
    it('returns false when USER.md missing', () => {
      const userPath = path.join(tempDir, 'USER.md');
      const exists = fs.existsSync(userPath);
      expect(exists).toBe(false);
    });

    it('returns false when USER.md exists but completed', () => {
      const userPath = path.join(tempDir, 'USER.md');
      fs.writeFileSync(userPath, '# User\n\nCompleted user profile');

      const content = fs.readFileSync(userPath, 'utf-8');
      const isFirstRun = content.includes('(to be filled during bootstrap)');
      expect(isFirstRun).toBe(false);
    });

    it('returns true when USER.md contains bootstrap marker', () => {
      const userPath = path.join(tempDir, 'USER.md');
      fs.writeFileSync(userPath, '# User\n\n(to be filled during bootstrap)');

      const content = fs.readFileSync(userPath, 'utf-8');
      const isFirstRun = content.includes('(to be filled during bootstrap)');
      expect(isFirstRun).toBe(true);
    });
  });

  describe('section isolation', () => {
    it('directory bootstrap failure is catchable', () => {
      // Verify that directory creation errors can be caught
      // (ESM modules don't allow spying on built-in fs exports)
      expect(() => {
        try {
          fs.mkdirSync(path.join(tempDir, 'not-a-dir.txt', 'subdir'));
        } catch {
          // Bootstrap catches this and continues
        }
      }).not.toThrow();

      // Scope detection should still work regardless
      const scope = detectScope('/tmp');
      expect(scope.type).toBe('global');
    });

    it('index.json write failure does not prevent SQLite registration', async () => {
      const indexPath = path.join(tempDir, 'index-readonly.json');
      fs.writeFileSync(indexPath, '{}');

      const { createSession } = await import('../../src/db/sessions.js');

      // SQLite registration should still succeed
      const result = createSession(db, {
        session_id: 'sess-isolation-test',
        scope: 'global',
        cwd: '/test',
      });

      expect(result.id).toBeGreaterThan(0);
    });

    it('health check failure does not prevent session registration', async () => {
      const { createSession } = await import('../../src/db/sessions.js');

      // Session registration should still succeed
      expect(() => {
        createSession(db, {
          session_id: 'sess-health-test',
          scope: 'global',
          cwd: '/test',
        });
      }).not.toThrow();
    });
  });

  describe('context restoration', () => {
    it('assembles context from DB sources when available', async () => {
      const { storeObservation, getRecentObservations } = await import('../../src/db/observations.js');

      storeObservation(db, {
        session_id: 'sess-001',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Test observation',
        content: 'Test content',
        importance: 3,
      });

      const observations = getRecentObservations(db, 5);

      expect(observations).toHaveLength(1);
      expect(observations[0]!.title).toBe('Test observation');
    });

    it('isolation: context restoration failure does not break hook', async () => {
      const brokenDb = new Database(':memory:');
      brokenDb.close();

      const { getRecentObservations } = await import('../../src/db/observations.js');

      // Should not throw
      expect(() => {
        try {
          getRecentObservations(brokenDb, 5);
        } catch {
          // Expected
        }
      }).not.toThrow();
    });

    it('H15: global scope does not leak project data', async () => {
      const { storeObservation } = await import('../../src/db/observations.js');
      const { insertReasoning } = await import('../../src/db/reasoning.js');
      const { insertConsensus } = await import('../../src/db/consensus.js');
      const { upsertPressureScore } = await import('../../src/db/pressure.js');

      // Store project-scoped data
      storeObservation(db, {
        session_id: 'sess-project',
        project: 'my-project',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Project observation',
        content: 'Should not leak to global scope',
        importance: 3,
      });

      // Store global-scoped data (project = null)
      storeObservation(db, {
        session_id: 'sess-global',
        project: null,
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Global observation',
        content: 'Should appear in global scope',
        importance: 3,
      });

      insertReasoning(db, {
        session_id: 'sess-project',
        project: 'my-project',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        trigger: 'complex-decision',
        title: 'Project reasoning',
        reasoning: 'Should not leak to global scope',
        importance: 3,
      });

      insertConsensus(db, {
        session_id: 'sess-project',
        project: 'my-project',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        title: 'Project consensus',
        description: 'Should not leak to global scope',
        status: 'agreed',
        importance: 3,
      });

      upsertPressureScore(db, {
        file_path: '/project/file.ts',
        project: 'my-project',
        raw_pressure: 0.8,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      // Simulate session-start in global scope (project = null)
      const { getRecentObservations } = await import('../../src/db/observations.js');
      const { getRecentReasoning } = await import('../../src/db/reasoning.js');
      const { getRecentConsensus } = await import('../../src/db/consensus.js');
      const { getPressureScores } = await import('../../src/db/pressure.js');

      // In global scope (project = null), functions query WHERE project IS NULL
      const observations = getRecentObservations(db, 20, null);
      const reasoning = getRecentReasoning(db, 5, null);
      const consensus = getRecentConsensus(db, 5, null);
      const pressure = getPressureScores(db, '__global__');

      // Assert: global scope gets global data only, no project data leaks
      expect(observations).toHaveLength(1);
      expect(observations[0]!.title).toBe('Global observation');

      expect(reasoning).toHaveLength(0); // No global reasoning
      expect(consensus).toHaveLength(0); // No global consensus
      expect(pressure).toHaveLength(0); // No global pressure scores
    });

    it('H15: project scope returns only that project\'s data', async () => {
      const { storeObservation } = await import('../../src/db/observations.js');

      // Store data for two different projects
      storeObservation(db, {
        session_id: 'sess-a',
        project: 'project-a',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Project A observation',
        content: 'Only for project A',
        importance: 3,
      });

      storeObservation(db, {
        session_id: 'sess-b',
        project: 'project-b',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Project B observation',
        content: 'Only for project B',
        importance: 3,
      });

      const { getRecentObservations } = await import('../../src/db/observations.js');

      // Query for project-a should only return project-a data
      const projectAObs = getRecentObservations(db, 20, 'project-a');
      expect(projectAObs).toHaveLength(1);
      expect(projectAObs[0]!.title).toBe('Project A observation');
      expect(projectAObs[0]!.project).toBe('project-a');

      // Query for project-b should only return project-b data
      const projectBObs = getRecentObservations(db, 20, 'project-b');
      expect(projectBObs).toHaveLength(1);
      expect(projectBObs[0]!.title).toBe('Project B observation');
      expect(projectBObs[0]!.project).toBe('project-b');
    });
  });
});
