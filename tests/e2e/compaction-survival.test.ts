/**
 * Claudex v2 — E2E: Compaction Survival
 *
 * Verifies that all persisted data survives across session boundaries,
 * simulating the compaction scenario: session runs → data captured to DB →
 * compaction occurs → new session can access all prior data.
 *
 * We test the DATA flow, not actual compaction (which is Claude Code internal).
 * If data is in the DB before compaction, it must be there after.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MigrationRunner } from '../../src/db/migrations.js';
import { insertReasoning, getRecentReasoning, getReasoningBySession } from '../../src/db/reasoning.js';
import { upsertPressureScore, getPressureScores, getHotFiles } from '../../src/db/pressure.js';
import { storeObservation, getRecentObservations, getObservationsBySession } from '../../src/db/observations.js';
import { createSession, updateSessionStatus, getActiveSession } from '../../src/db/sessions.js';
import { searchAll, searchObservations } from '../../src/db/search.js';
import { assembleContext } from '../../src/lib/context-assembler.js';
import {
  mirrorObservation,
  mirrorReasoning,
  mirrorPressureScores,
} from '../../src/lib/flat-file-mirror.js';
import type { ReasoningChain, Observation, ContextSources, PressureScore, Scope } from '../../src/shared/types.js';

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

type ReasoningInput = Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'>;

function makeReasoning(overrides: Partial<ReasoningInput> = {}): ReasoningInput {
  return {
    session_id: 'session-1',
    project: 'test-project',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    trigger: 'pre_compact',
    title: 'Test reasoning chain',
    reasoning: 'Some reasoning content',
    importance: 3,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'session-1',
    project: 'test-project',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    tool_name: 'Read',
    category: 'discovery',
    title: 'Test observation',
    content: 'Test observation content',
    importance: 3,
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

/** Simulate ending a session and starting a new one */
function transitionSession(
  db: Database.Database,
  oldSessionId: string,
  newSessionId: string,
): void {
  updateSessionStatus(db, oldSessionId, 'completed', new Date().toISOString());
  createSession(db, {
    session_id: newSessionId,
    scope: 'project:test-project',
    project: 'test-project',
    cwd: '/test',
  });
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

describe('Compaction Survival E2E', () => {
  // ===========================================================================
  // Reasoning chains survive across sessions
  // ===========================================================================

  describe('reasoning chains survive across sessions', () => {
    it('reasoning stored in session 1 is accessible in session 2', () => {
      // Session 1: create session, insert reasoning
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });

      insertReasoning(db, makeReasoning({
        session_id: 'session-1',
        title: 'Architecture decision: use JWT',
        reasoning: 'JWT was chosen because it enables stateless auth and works well with microservices',
        importance: 4,
        decisions: ['Use JWT for auth', 'Store tokens in httpOnly cookies'],
      }));

      // End session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      // Session 2: query reasoning — should find session 1 data
      const reasoning = getRecentReasoning(db, 10, 'test-project');
      expect(reasoning.length).toBeGreaterThan(0);
      expect(reasoning[0]!.title).toBe('Architecture decision: use JWT');
      expect(reasoning[0]!.decisions).toEqual(['Use JWT for auth', 'Store tokens in httpOnly cookies']);
      expect(reasoning[0]!.session_id).toBe('session-1');
    });

    it('reasoning from multiple sessions accumulates', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'session-1',
        timestamp_epoch: 1000,
        title: 'Decision A from session 1',
      }));

      transitionSession(db, 'session-1', 'session-2');
      insertReasoning(db, makeReasoning({
        session_id: 'session-2',
        timestamp_epoch: 2000,
        title: 'Decision B from session 2',
      }));

      transitionSession(db, 'session-2', 'session-3');

      // Session 3: should see both reasoning chains
      const reasoning = getRecentReasoning(db, 10, 'test-project');
      expect(reasoning).toHaveLength(2);
      // Ordered DESC by timestamp_epoch
      expect(reasoning[0]!.title).toBe('Decision B from session 2');
      expect(reasoning[1]!.title).toBe('Decision A from session 1');
    });

    it('getReasoningBySession still scopes to a single session', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({ session_id: 'session-1', title: 'Session 1 chain' }));

      transitionSession(db, 'session-1', 'session-2');
      insertReasoning(db, makeReasoning({ session_id: 'session-2', title: 'Session 2 chain' }));

      const s1Chains = getReasoningBySession(db, 'session-1');
      expect(s1Chains).toHaveLength(1);
      expect(s1Chains[0]!.title).toBe('Session 1 chain');

      const s2Chains = getReasoningBySession(db, 'session-2');
      expect(s2Chains).toHaveLength(1);
      expect(s2Chains[0]!.title).toBe('Session 2 chain');
    });
  });

  // ===========================================================================
  // Pressure scores persist
  // ===========================================================================

  describe('pressure scores persist across sessions', () => {
    it('pressure scores from session 1 available in session 2', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });

      upsertPressureScore(db, {
        file_path: 'src/auth.ts',
        project: 'test-project',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/utils.ts',
        project: 'test-project',
        raw_pressure: 0.4,
        temperature: 'WARM',
        decay_rate: 0.05,
      });

      // End session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      // Session 2: read pressure scores
      const scores = getPressureScores(db, 'test-project');
      expect(scores).toHaveLength(2);
      // Ordered by raw_pressure DESC
      expect(scores[0]!.file_path).toBe('src/auth.ts');
      expect(scores[0]!.temperature).toBe('HOT');
      expect(scores[0]!.raw_pressure).toBe(0.9);
      expect(scores[1]!.file_path).toBe('src/utils.ts');
      expect(scores[1]!.temperature).toBe('WARM');
    });

    it('pressure scores can be updated across sessions', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      upsertPressureScore(db, {
        file_path: 'src/auth.ts',
        project: 'test-project',
        raw_pressure: 0.5,
        temperature: 'WARM',
        decay_rate: 0.05,
      });

      transitionSession(db, 'session-1', 'session-2');

      // Session 2: update same file to HOT
      upsertPressureScore(db, {
        file_path: 'src/auth.ts',
        project: 'test-project',
        raw_pressure: 0.95,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const scores = getPressureScores(db, 'test-project');
      expect(scores).toHaveLength(1); // upsert, not duplicate
      expect(scores[0]!.raw_pressure).toBe(0.95);
      expect(scores[0]!.temperature).toBe('HOT');
    });

    it('getHotFiles returns only HOT files after session transition', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      upsertPressureScore(db, {
        file_path: 'src/hot-file.ts',
        project: 'test-project',
        raw_pressure: 0.85,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/cold-file.ts',
        project: 'test-project',
        raw_pressure: 0.1,
        temperature: 'COLD',
        decay_rate: 0.05,
      });

      transitionSession(db, 'session-1', 'session-2');

      const hotFiles = getHotFiles(db, 'test-project');
      expect(hotFiles).toHaveLength(1);
      expect(hotFiles[0]!.file_path).toBe('src/hot-file.ts');
    });
  });

  // ===========================================================================
  // Observations persist across sessions
  // ===========================================================================

  describe('observations persist across sessions', () => {
    it('observations from session 1 retrievable in session 2', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      storeObservation(db, makeObservation({
        session_id: 'session-1',
        title: 'Found memory leak in auth module',
        content: 'The authentication handler was not releasing connections',
        category: 'bugfix',
        importance: 4,
      }));

      transitionSession(db, 'session-1', 'session-2');

      // Session 2: recent observations should include session 1 data
      const observations = getRecentObservations(db, 10, 'test-project');
      expect(observations.length).toBeGreaterThan(0);
      expect(observations[0]!.title).toBe('Found memory leak in auth module');
      expect(observations[0]!.session_id).toBe('session-1');
    });

    it('observations from session 1 searchable via FTS5 in session 2', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      storeObservation(db, makeObservation({
        session_id: 'session-1',
        title: 'Configured PostgreSQL connection pooling',
        content: 'Set up pgBouncer with transaction mode for better scalability',
        category: 'configuration',
        importance: 3,
      }));

      transitionSession(db, 'session-1', 'session-2');

      // Session 2: FTS5 search should find session 1 observation
      const results = searchObservations(db, 'PostgreSQL', { project: 'test-project' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.observation.title).toContain('PostgreSQL');
    });

    it('getObservationsBySession scopes correctly across sessions', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      storeObservation(db, makeObservation({ session_id: 'session-1', title: 'Obs from S1' }));

      transitionSession(db, 'session-1', 'session-2');
      storeObservation(db, makeObservation({ session_id: 'session-2', title: 'Obs from S2' }));

      const s1Obs = getObservationsBySession(db, 'session-1');
      expect(s1Obs).toHaveLength(1);
      expect(s1Obs[0]!.title).toBe('Obs from S1');

      const s2Obs = getObservationsBySession(db, 'session-2');
      expect(s2Obs).toHaveLength(1);
      expect(s2Obs[0]!.title).toBe('Obs from S2');
    });
  });

  // ===========================================================================
  // Context assembly uses persisted data
  // ===========================================================================

  describe('context assembly uses persisted data', () => {
    beforeEach(() => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('assembleContext includes reasoning from previous sessions', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'session-1',
        timestamp_epoch: 1700000000000 - 60000, // 1 minute ago
        title: 'Chose event sourcing pattern',
        reasoning: 'Event sourcing provides full audit trail and enables temporal queries',
        importance: 4,
      }));

      transitionSession(db, 'session-1', 'session-2');

      // Session 2: assemble context using reasoning from DB
      const reasoning = getRecentReasoning(db, 5, 'test-project');
      const sources: ContextSources = {
        hologram: null,
        searchResults: [],
        recentObservations: [],
        reasoningChains: reasoning,
        scope: { type: 'project', name: 'test-project', path: '/test' },
      };

      const assembled = assembleContext(sources, { maxTokens: 4000 });
      expect(assembled.markdown).toContain('Flow Reasoning');
      expect(assembled.markdown).toContain('Chose event sourcing pattern');
      expect(assembled.sources).toContain('reasoning');
    });

    it('assembleContext includes post-compaction continuity flag', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'session-1',
        timestamp_epoch: 1700000000000 - 120000,
        title: 'Pre-compaction reasoning',
        reasoning: 'Captured before compaction triggered',
      }));

      transitionSession(db, 'session-1', 'session-2');

      const reasoning = getRecentReasoning(db, 5, 'test-project');
      const sources: ContextSources = {
        hologram: null,
        searchResults: [],
        recentObservations: [],
        reasoningChains: reasoning,
        postCompaction: true,
        scope: { type: 'project', name: 'test-project', path: '/test' },
      };

      const assembled = assembleContext(sources, { maxTokens: 4000 });
      expect(assembled.markdown).toContain('Session Continuity');
      expect(assembled.markdown).toContain('compacted');
      expect(assembled.sources).toContain('session');
      expect(assembled.sources).toContain('reasoning');
    });
  });

  // ===========================================================================
  // Unified search across sessions
  // ===========================================================================

  describe('unified search finds data across sessions', () => {
    it('searchAll finds observations and reasoning from prior sessions', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      storeObservation(db, makeObservation({
        session_id: 'session-1',
        title: 'Discovered WebSocket reconnection strategy',
        content: 'Implemented exponential backoff with jitter for reconnections',
      }));
      insertReasoning(db, makeReasoning({
        session_id: 'session-1',
        title: 'WebSocket protocol selection',
        reasoning: 'Chose WebSocket over SSE for bidirectional communication needs',
      }));

      transitionSession(db, 'session-1', 'session-2');

      // Session 2: unified search should find both
      const results = searchAll(db, 'WebSocket', { project: 'test-project' });
      expect(results.length).toBe(2);
      const titles = results.map(r => r.observation.title);
      expect(titles).toContain('Discovered WebSocket reconnection strategy');
      expect(titles).toContain('WebSocket protocol selection');
    });
  });

  // ===========================================================================
  // Session state tracking
  // ===========================================================================

  describe('session lifecycle tracking', () => {
    it('active session transitions correctly across compaction boundary', () => {
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });

      let active = getActiveSession(db);
      expect(active).not.toBeNull();
      expect(active!.session_id).toBe('session-1');
      expect(active!.status).toBe('active');

      // Complete session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      active = getActiveSession(db);
      expect(active).not.toBeNull();
      expect(active!.session_id).toBe('session-2');
      expect(active!.status).toBe('active');
    });
  });

  // ===========================================================================
  // Multiple compaction cycles
  // ===========================================================================

  describe('multiple compaction cycles', () => {
    it('data survives 3 consecutive session cycles', () => {
      // Session 1: store reasoning + observation + pressure
      createSession(db, {
        session_id: 'cycle-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'cycle-1',
        timestamp_epoch: 1000,
        title: 'Cycle 1 reasoning',
        reasoning: 'First session architectural decision',
      }));
      storeObservation(db, makeObservation({
        session_id: 'cycle-1',
        timestamp_epoch: 1000,
        title: 'Cycle 1 observation',
        content: 'Discovered pattern in first session',
      }));
      upsertPressureScore(db, {
        file_path: 'src/core.ts',
        project: 'test-project',
        raw_pressure: 0.8,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      // Session 2: store more data
      transitionSession(db, 'cycle-1', 'cycle-2');
      insertReasoning(db, makeReasoning({
        session_id: 'cycle-2',
        timestamp_epoch: 2000,
        title: 'Cycle 2 reasoning',
        reasoning: 'Second session refactoring decision',
      }));
      storeObservation(db, makeObservation({
        session_id: 'cycle-2',
        timestamp_epoch: 2000,
        title: 'Cycle 2 observation',
        content: 'Refactored module in second session',
      }));
      upsertPressureScore(db, {
        file_path: 'src/api.ts',
        project: 'test-project',
        raw_pressure: 0.6,
        temperature: 'WARM',
        decay_rate: 0.05,
      });

      // Session 3: store final data
      transitionSession(db, 'cycle-2', 'cycle-3');
      insertReasoning(db, makeReasoning({
        session_id: 'cycle-3',
        timestamp_epoch: 3000,
        title: 'Cycle 3 reasoning',
        reasoning: 'Third session optimization decision',
      }));
      storeObservation(db, makeObservation({
        session_id: 'cycle-3',
        timestamp_epoch: 3000,
        title: 'Cycle 3 observation',
        content: 'Optimized queries in third session',
      }));

      // Verify: all reasoning chains from all sessions
      const reasoning = getRecentReasoning(db, 10, 'test-project');
      expect(reasoning).toHaveLength(3);
      expect(reasoning[0]!.title).toBe('Cycle 3 reasoning');
      expect(reasoning[1]!.title).toBe('Cycle 2 reasoning');
      expect(reasoning[2]!.title).toBe('Cycle 1 reasoning');

      // Verify: all observations from all sessions
      const observations = getRecentObservations(db, 10, 'test-project');
      expect(observations).toHaveLength(3);
      expect(observations[0]!.title).toBe('Cycle 3 observation');
      expect(observations[1]!.title).toBe('Cycle 2 observation');
      expect(observations[2]!.title).toBe('Cycle 1 observation');

      // Verify: pressure scores accumulated
      const scores = getPressureScores(db, 'test-project');
      expect(scores).toHaveLength(2);
      const paths = scores.map(s => s.file_path);
      expect(paths).toContain('src/core.ts');
      expect(paths).toContain('src/api.ts');
    });

    it('session-scoped queries still work after 3 cycles', () => {
      createSession(db, {
        session_id: 'cyc-a',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: '/test',
      });
      insertReasoning(db, makeReasoning({ session_id: 'cyc-a', title: 'A chain' }));
      storeObservation(db, makeObservation({ session_id: 'cyc-a', title: 'A obs' }));

      transitionSession(db, 'cyc-a', 'cyc-b');
      insertReasoning(db, makeReasoning({ session_id: 'cyc-b', title: 'B chain' }));
      storeObservation(db, makeObservation({ session_id: 'cyc-b', title: 'B obs' }));

      transitionSession(db, 'cyc-b', 'cyc-c');
      insertReasoning(db, makeReasoning({ session_id: 'cyc-c', title: 'C chain' }));
      storeObservation(db, makeObservation({ session_id: 'cyc-c', title: 'C obs' }));

      // Each session's data is independently scoped
      expect(getReasoningBySession(db, 'cyc-a')).toHaveLength(1);
      expect(getReasoningBySession(db, 'cyc-b')).toHaveLength(1);
      expect(getReasoningBySession(db, 'cyc-c')).toHaveLength(1);

      expect(getObservationsBySession(db, 'cyc-a')).toHaveLength(1);
      expect(getObservationsBySession(db, 'cyc-b')).toHaveLength(1);
      expect(getObservationsBySession(db, 'cyc-c')).toHaveLength(1);
    });
  });

  // ===========================================================================
  // Cross-project isolation
  // ===========================================================================

  describe('cross-project isolation', () => {
    it('data from project A does not leak into project B queries', () => {
      createSession(db, {
        session_id: 'proj-a-sess',
        scope: 'project:alpha',
        project: 'alpha',
        cwd: '/alpha',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'proj-a-sess',
        project: 'alpha',
        title: 'Alpha architecture decision',
      }));
      storeObservation(db, makeObservation({
        session_id: 'proj-a-sess',
        project: 'alpha',
        title: 'Alpha observation',
      }));
      upsertPressureScore(db, {
        file_path: 'src/alpha.ts',
        project: 'alpha',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      createSession(db, {
        session_id: 'proj-b-sess',
        scope: 'project:beta',
        project: 'beta',
        cwd: '/beta',
      });
      insertReasoning(db, makeReasoning({
        session_id: 'proj-b-sess',
        project: 'beta',
        title: 'Beta architecture decision',
      }));

      // Project-scoped queries should be isolated
      const alphaReasoning = getRecentReasoning(db, 10, 'alpha');
      expect(alphaReasoning).toHaveLength(1);
      expect(alphaReasoning[0]!.title).toBe('Alpha architecture decision');

      const betaReasoning = getRecentReasoning(db, 10, 'beta');
      expect(betaReasoning).toHaveLength(1);
      expect(betaReasoning[0]!.title).toBe('Beta architecture decision');

      const alphaObs = getRecentObservations(db, 10, 'alpha');
      expect(alphaObs).toHaveLength(1);

      const betaObs = getRecentObservations(db, 10, 'beta');
      expect(betaObs).toHaveLength(0);

      const alphaScores = getPressureScores(db, 'alpha');
      expect(alphaScores).toHaveLength(1);

      const betaScores = getPressureScores(db, 'beta');
      expect(betaScores).toHaveLength(0);
    });
  });

  // ===========================================================================
  // Full compaction simulation
  // ===========================================================================

  describe('full compaction simulation', () => {
    it('complete lifecycle: session start → data capture → compaction → reassembly', () => {
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);

      // Phase 1: Session starts, work happens, data is captured
      createSession(db, {
        session_id: 'real-session-1',
        scope: 'project:myapp',
        project: 'myapp',
        cwd: '/work/myapp',
      });

      // Developer works on auth module — observations captured
      storeObservation(db, makeObservation({
        session_id: 'real-session-1',
        project: 'myapp',
        timestamp_epoch: 1700000000000 - 300000, // 5 min ago
        title: 'Investigated OAuth2 flow',
        content: 'Mapped out the complete OAuth2 authorization code flow for the API',
        category: 'discovery',
        importance: 4,
        files_read: ['src/auth/oauth.ts', 'src/auth/tokens.ts'],
      }));

      // Pressure builds on auth files
      upsertPressureScore(db, {
        file_path: 'src/auth/oauth.ts',
        project: 'myapp',
        raw_pressure: 0.85,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
      upsertPressureScore(db, {
        file_path: 'src/auth/tokens.ts',
        project: 'myapp',
        raw_pressure: 0.75,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      // Phase 2: Context reaches threshold — pre-compact captures reasoning
      insertReasoning(db, makeReasoning({
        session_id: 'real-session-1',
        project: 'myapp',
        timestamp_epoch: 1700000000000 - 60000, // 1 min ago
        trigger: 'pre_compact',
        title: 'OAuth2 implementation strategy',
        reasoning: 'Decided to use PKCE flow with refresh token rotation. The API gateway handles token exchange to keep client-side simple.',
        importance: 5,
        decisions: [
          'Use PKCE authorization code flow',
          'API gateway handles token exchange',
          'Refresh tokens rotate on each use',
        ],
        files_involved: ['src/auth/oauth.ts', 'src/auth/tokens.ts', 'src/gateway/middleware.ts'],
      }));

      // Phase 3: Compaction happens — session ends
      updateSessionStatus(db, 'real-session-1', 'completed', new Date().toISOString());

      // Phase 4: New session starts (post-compaction)
      createSession(db, {
        session_id: 'real-session-2',
        scope: 'project:myapp',
        project: 'myapp',
        cwd: '/work/myapp',
      });

      // Phase 5: Context assembly rebuilds state from persisted data
      const reasoning = getRecentReasoning(db, 5, 'myapp');
      const observations = getRecentObservations(db, 5, 'myapp');
      const hotFiles = getHotFiles(db, 'myapp');

      const sources: ContextSources = {
        hologram: {
          hot: hotFiles.map(f => ({
            path: f.file_path,
            raw_pressure: f.raw_pressure,
            temperature: f.temperature,
            system_bucket: 1,
            pressure_bucket: 1,
          })),
          warm: [],
          cold: [],
        },
        searchResults: [],
        recentObservations: observations,
        reasoningChains: reasoning,
        postCompaction: true,
        scope: { type: 'project', name: 'myapp', path: '/work/myapp' },
      };

      const assembled = assembleContext(sources, { maxTokens: 4000 });

      // Verify: full context was rebuilt
      expect(assembled.markdown).toContain('Flow Reasoning');
      expect(assembled.markdown).toContain('OAuth2 implementation strategy');
      expect(assembled.markdown).toContain('Active Focus');
      expect(assembled.markdown).toContain('src/auth/oauth.ts');
      expect(assembled.markdown).toContain('Session Continuity');
      expect(assembled.sources).toContain('reasoning');
      expect(assembled.sources).toContain('hologram');
      expect(assembled.sources).toContain('session');
      expect(assembled.tokenEstimate).toBeGreaterThan(0);
      expect(assembled.tokenEstimate).toBeLessThanOrEqual(4000);

      vi.restoreAllMocks();
    });
  });

  // ===========================================================================
  // Flat-file mirrors survive compaction
  // ===========================================================================

  describe('flat-file mirrors survive compaction', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-mirror-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function projectScope(): Scope {
      return { type: 'project', name: 'test-project', path: tmpDir };
    }

    it('observation mirrors persist across sessions', () => {
      // Session 1: store observation in DB and mirror it
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const obs = makeObservation({
        session_id: 'session-1',
        timestamp: '2026-02-15T10:00:00.000Z',
        title: 'Discovered cache layer',
        content: 'The app uses Redis for session caching',
        category: 'discovery',
        importance: 4,
      });

      storeObservation(db, obs);
      mirrorObservation(obs, projectScope());

      // Verify mirror file created
      const mirrorPath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      expect(fs.existsSync(mirrorPath)).toBe(true);

      const content1 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content1).toContain('Discovered cache layer');
      expect(content1).toContain('Redis for session caching');

      // End session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      // Session 2: mirror file should still exist
      expect(fs.existsSync(mirrorPath)).toBe(true);

      const content2 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content2).toContain('Discovered cache layer');
      expect(content2).toContain('Redis for session caching');

      // DB should also have the observation
      const dbObs = getRecentObservations(db, 10, 'test-project');
      expect(dbObs.length).toBeGreaterThan(0);
      expect(dbObs[0]!.title).toBe('Discovered cache layer');
    });

    it('reasoning mirrors persist across sessions', () => {
      // Session 1: store reasoning in DB and mirror it
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const reasoning = makeReasoning({
        session_id: 'session-1',
        timestamp: '2026-02-15T11:30:00.000Z',
        title: 'Use Redis for sessions',
        reasoning: 'Redis provides fast access and built-in expiration for session data',
        importance: 4,
        decisions: ['Use Redis Cluster', 'Set 24h TTL on sessions'],
      });

      insertReasoning(db, reasoning);
      mirrorReasoning(reasoning, projectScope());

      // Verify mirror file created
      const mirrorDir = path.join(tmpDir, 'context', 'reasoning', 'session-1');
      expect(fs.existsSync(mirrorDir)).toBe(true);

      const files1 = fs.readdirSync(mirrorDir);
      expect(files1.length).toBe(1);

      const content1 = fs.readFileSync(path.join(mirrorDir, files1[0]!), 'utf-8');
      expect(content1).toContain('Use Redis for sessions');
      expect(content1).toContain('fast access');
      expect(content1).toContain('Use Redis Cluster');

      // End session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      // Session 2: mirror file should still exist
      expect(fs.existsSync(mirrorDir)).toBe(true);

      const files2 = fs.readdirSync(mirrorDir);
      expect(files2.length).toBe(1);

      const content2 = fs.readFileSync(path.join(mirrorDir, files2[0]!), 'utf-8');
      expect(content2).toContain('Use Redis for sessions');
      expect(content2).toContain('Use Redis Cluster');

      // DB should also have the reasoning
      const dbReasoning = getRecentReasoning(db, 10, 'test-project');
      expect(dbReasoning.length).toBeGreaterThan(0);
      expect(dbReasoning[0]!.title).toBe('Use Redis for sessions');
    });

    it('pressure score mirrors persist across sessions', () => {
      // Session 1: store pressure scores in DB and mirror them
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const scores: PressureScore[] = [
        {
          file_path: 'src/cache.ts',
          raw_pressure: 0.85,
          temperature: 'HOT',
          decay_rate: 0.05,
        },
        {
          file_path: 'src/session.ts',
          raw_pressure: 0.6,
          temperature: 'WARM',
          decay_rate: 0.03,
        },
      ];

      for (const score of scores) {
        upsertPressureScore(db, { ...score, project: 'test-project' });
      }
      mirrorPressureScores(scores, projectScope());

      // Verify mirror file created
      const mirrorPath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      expect(fs.existsSync(mirrorPath)).toBe(true);

      const content1 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content1).toContain('src/cache.ts');
      expect(content1).toContain('0.850');
      expect(content1).toContain('HOT');
      expect(content1).toContain('src/session.ts');
      expect(content1).toContain('WARM');

      // End session 1, start session 2
      transitionSession(db, 'session-1', 'session-2');

      // Session 2: mirror file should still exist
      expect(fs.existsSync(mirrorPath)).toBe(true);

      const content2 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content2).toContain('src/cache.ts');
      expect(content2).toContain('0.850');
      expect(content2).toContain('src/session.ts');

      // DB should also have the pressure scores
      const dbScores = getPressureScores(db, 'test-project');
      expect(dbScores.length).toBe(2);
      expect(dbScores[0]!.file_path).toBe('src/cache.ts');
      expect(dbScores[1]!.file_path).toBe('src/session.ts');
    });

    it('observation mirrors accumulate across multiple sessions', () => {
      // Session 1: create first observation
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const obs1 = makeObservation({
        session_id: 'session-1',
        timestamp: '2026-02-15T10:00:00.000Z',
        title: 'Session 1 observation',
        content: 'Found pattern A',
      });
      storeObservation(db, obs1);
      mirrorObservation(obs1, projectScope());

      const mirrorPath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      const content1 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content1).toContain('Session 1 observation');

      // Session 2: add second observation to same day
      transitionSession(db, 'session-1', 'session-2');

      const obs2 = makeObservation({
        session_id: 'session-2',
        timestamp: '2026-02-15T14:00:00.000Z',
        title: 'Session 2 observation',
        content: 'Found pattern B',
      });
      storeObservation(db, obs2);
      mirrorObservation(obs2, projectScope());

      // Session 2: mirror file should contain BOTH observations
      const content2 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content2).toContain('Session 1 observation');
      expect(content2).toContain('Session 2 observation');
      expect(content2).toContain('Found pattern A');
      expect(content2).toContain('Found pattern B');

      // DB should also have both
      const dbObs = getRecentObservations(db, 10, 'test-project');
      expect(dbObs.length).toBe(2);
    });

    it('reasoning mirrors from different sessions remain independent', () => {
      // Session 1: create reasoning
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const reasoning1 = makeReasoning({
        session_id: 'session-1',
        timestamp: '2026-02-15T10:00:00.000Z',
        title: 'Session 1 decision',
      });
      insertReasoning(db, reasoning1);
      mirrorReasoning(reasoning1, projectScope());

      // Session 2: create different reasoning
      transitionSession(db, 'session-1', 'session-2');

      const reasoning2 = makeReasoning({
        session_id: 'session-2',
        timestamp: '2026-02-15T14:00:00.000Z',
        title: 'Session 2 decision',
      });
      insertReasoning(db, reasoning2);
      mirrorReasoning(reasoning2, projectScope());

      // Verify: each session has its own directory
      const dir1 = path.join(tmpDir, 'context', 'reasoning', 'session-1');
      const dir2 = path.join(tmpDir, 'context', 'reasoning', 'session-2');

      expect(fs.existsSync(dir1)).toBe(true);
      expect(fs.existsSync(dir2)).toBe(true);

      const files1 = fs.readdirSync(dir1);
      const files2 = fs.readdirSync(dir2);

      expect(files1).toHaveLength(1);
      expect(files2).toHaveLength(1);

      const content1 = fs.readFileSync(path.join(dir1, files1[0]!), 'utf-8');
      const content2 = fs.readFileSync(path.join(dir2, files2[0]!), 'utf-8');

      expect(content1).toContain('Session 1 decision');
      expect(content1).not.toContain('Session 2 decision');
      expect(content2).toContain('Session 2 decision');
      expect(content2).not.toContain('Session 1 decision');
    });

    it('pressure score mirrors get overwritten (snapshot behavior)', () => {
      // Session 1: write initial pressure scores
      createSession(db, {
        session_id: 'session-1',
        scope: 'project:test-project',
        project: 'test-project',
        cwd: tmpDir,
      });

      const scores1: PressureScore[] = [
        { file_path: 'src/old-file.ts', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 },
      ];
      for (const score of scores1) {
        upsertPressureScore(db, { ...score, project: 'test-project' });
      }
      mirrorPressureScores(scores1, projectScope());

      const mirrorPath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      const content1 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content1).toContain('src/old-file.ts');

      // Session 2: overwrite with new pressure scores
      transitionSession(db, 'session-1', 'session-2');

      const scores2: PressureScore[] = [
        { file_path: 'src/new-file.ts', raw_pressure: 0.7, temperature: 'HOT', decay_rate: 0.04 },
      ];
      for (const score of scores2) {
        upsertPressureScore(db, { ...score, project: 'test-project' });
      }
      mirrorPressureScores(scores2, projectScope());

      // Verify: only new scores are in mirror file (not accumulated)
      const content2 = fs.readFileSync(mirrorPath, 'utf-8');
      expect(content2).toContain('src/new-file.ts');
      expect(content2).not.toContain('src/old-file.ts');

      // Note: DB keeps both via upsert, but mirror is snapshot-only
    });
  });
});
