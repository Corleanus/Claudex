/**
 * Claudex v2 — E2E Session Lifecycle Test
 *
 * Tests the complete data flow through DB operations:
 * session-start → observation capture → search → context assembly →
 * reasoning capture → consensus → pressure scores → session-end
 *
 * NOT testing actual hook execution (stdin/stdout piping), only the
 * storage and retrieval layer that hooks depend on.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { createSession, updateSessionStatus, getActiveSession, incrementObservationCount } from '../../src/db/sessions.js';
import { storeObservation, getRecentObservations, getObservationsBySession } from '../../src/db/observations.js';
import { insertReasoning, getRecentReasoning, getReasoningBySession } from '../../src/db/reasoning.js';
import { insertConsensus, getRecentConsensus, getConsensusBySession } from '../../src/db/consensus.js';
import { upsertPressureScore, getPressureScores } from '../../src/db/pressure.js';
import { searchAll, searchObservations } from '../../src/db/search.js';
import { assembleContext } from '../../src/lib/context-assembler.js';
import type { Observation } from '../../src/shared/types.js';

// Mock logger to prevent filesystem writes during tests
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

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'e2e-test-001',
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    tool_name: 'Read',
    category: 'discovery',
    title: 'Test observation',
    content: 'Test content body',
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

describe('Session Lifecycle E2E', () => {
  describe('full lifecycle', () => {
    it('session-start -> observation capture -> context assembly -> reasoning capture -> session-end', () => {
      // 1. Session start: createSession()
      const session = createSession(db, {
        session_id: 'e2e-test-001',
        scope: 'project:test',
        project: 'test',
        cwd: '/test',
      });
      expect(session.id).toBeGreaterThan(0);

      // 2. Verify active session
      const active = getActiveSession(db);
      expect(active).not.toBeNull();
      expect(active!.session_id).toBe('e2e-test-001');
      expect(active!.status).toBe('active');
      expect(active!.scope).toBe('project:test');
      expect(active!.project).toBe('test');

      // 3. Post-tool-use: store observations
      const obs1 = storeObservation(db, makeObservation({
        session_id: 'e2e-test-001',
        title: 'Found auth module',
        content: 'The auth module uses JWT tokens for session management',
        category: 'discovery',
        project: 'test',
      }));
      expect(obs1.id).toBeGreaterThan(0);

      const obs2 = storeObservation(db, makeObservation({
        session_id: 'e2e-test-001',
        title: 'Fixed login bug',
        content: 'The login form was not validating email format',
        category: 'bugfix',
        project: 'test',
      }));
      expect(obs2.id).toBeGreaterThan(0);

      // Increment observation count as the real hook would
      incrementObservationCount(db, 'e2e-test-001');
      incrementObservationCount(db, 'e2e-test-001');

      // 4. User-prompt-submit: search and assemble context
      const searchResults = searchAll(db, 'auth');
      expect(searchResults.length).toBeGreaterThan(0);
      expect(searchResults.some(r => r.observation.title === 'Found auth module')).toBe(true);

      const assembled = assembleContext({
        hologram: null,
        searchResults,
        recentObservations: getRecentObservations(db, 5),
        scope: { type: 'project', name: 'test', path: '/test' },
      }, { maxTokens: 4000 });
      expect(assembled.markdown).toContain('auth');
      expect(assembled.tokenEstimate).toBeGreaterThan(0);
      expect(assembled.sources.length).toBeGreaterThan(0);

      // 5. Pre-compact: capture reasoning
      const reasoning = insertReasoning(db, {
        session_id: 'e2e-test-001',
        project: 'test',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        trigger: 'pre_compact',
        title: 'Auth refactoring reasoning',
        reasoning: 'Decided to use JWT because it enables stateless authentication and simplifies horizontal scaling',
        importance: 4,
      });
      expect(reasoning.id).toBeGreaterThan(0);

      // 6. Verify reasoning persisted
      const recentReasoning = getRecentReasoning(db, 5, 'test');
      expect(recentReasoning.length).toBe(1);
      expect(recentReasoning[0]!.title).toBe('Auth refactoring reasoning');
      expect(recentReasoning[0]!.trigger).toBe('pre_compact');

      // 7. Insert consensus decision
      const consensus = insertConsensus(db, {
        session_id: 'e2e-test-001',
        project: 'test',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        title: 'JWT over session cookies',
        description: 'Team agreed to use JWT tokens instead of server-side session cookies',
        claude_position: 'JWT for stateless auth',
        codex_position: 'Agreed — simplifies deployment',
        human_verdict: 'Approved',
        status: 'agreed',
        importance: 5,
      });
      expect(consensus.id).toBeGreaterThan(0);

      // 8. Session end: update status
      const endedAt = new Date().toISOString();
      updateSessionStatus(db, 'e2e-test-001', 'completed', endedAt);

      const ended = getActiveSession(db);
      expect(ended).toBeNull(); // no active session after completion

      // 9. Verify observation count was tracked
      const sessionRow = db.prepare('SELECT observation_count FROM sessions WHERE session_id = ?').get('e2e-test-001') as { observation_count: number };
      expect(sessionRow.observation_count).toBe(2);
    });
  });

  describe('observation accumulation', () => {
    it('multiple observations across a session are all searchable', () => {
      createSession(db, {
        session_id: 'e2e-accum-001',
        scope: 'project:accum',
        project: 'accum',
        cwd: '/accum',
      });

      const topics = [
        { title: 'Database schema design', content: 'Normalized tables with foreign keys for referential integrity' },
        { title: 'Database migration strategy', content: 'Sequential versioned migrations with idempotent checks' },
        { title: 'Database indexing plan', content: 'Composite indexes on frequently queried columns' },
        { title: 'API endpoint design', content: 'RESTful routes with proper HTTP status codes' },
        { title: 'Frontend component hierarchy', content: 'React components with prop drilling minimized via context' },
      ];

      for (const topic of topics) {
        storeObservation(db, makeObservation({
          session_id: 'e2e-accum-001',
          project: 'accum',
          title: topic.title,
          content: topic.content,
        }));
      }

      // All three database observations should be found
      const dbResults = searchObservations(db, 'Database');
      expect(dbResults.length).toBe(3);

      // API observation should be found
      const apiResults = searchObservations(db, 'RESTful');
      expect(apiResults.length).toBe(1);
      expect(apiResults[0]!.observation.title).toBe('API endpoint design');

      // Frontend observation should be found
      const feResults = searchObservations(db, 'React');
      expect(feResults.length).toBe(1);
      expect(feResults[0]!.observation.title).toBe('Frontend component hierarchy');

      // Session-scoped retrieval returns all
      const allBySession = getObservationsBySession(db, 'e2e-accum-001');
      expect(allBySession.length).toBe(5);
    });
  });

  describe('cross-session continuity', () => {
    it('session 2 can find observations from session 1', () => {
      // Session 1: store observations
      createSession(db, {
        session_id: 'e2e-cross-001',
        scope: 'project:cross',
        project: 'cross',
        cwd: '/cross',
      });

      storeObservation(db, makeObservation({
        session_id: 'e2e-cross-001',
        project: 'cross',
        title: 'Discovered authentication vulnerability',
        content: 'SQL injection in login endpoint needs parameterized queries',
        category: 'bugfix',
        importance: 5,
      }));

      insertReasoning(db, {
        session_id: 'e2e-cross-001',
        project: 'cross',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        trigger: 'session_end',
        title: 'Security audit conclusions',
        reasoning: 'All SQL queries must use parameterized statements to prevent injection attacks',
        importance: 5,
      });

      updateSessionStatus(db, 'e2e-cross-001', 'completed', new Date().toISOString());

      // Session 2: search across history
      createSession(db, {
        session_id: 'e2e-cross-002',
        scope: 'project:cross',
        project: 'cross',
        cwd: '/cross',
      });

      // Unified search finds observation from session 1
      const results = searchAll(db, 'injection');
      expect(results.length).toBeGreaterThan(0);

      // At least one result from session 1
      const fromSession1 = results.filter(r => r.observation.session_id === 'e2e-cross-001');
      expect(fromSession1.length).toBeGreaterThan(0);

      // Recent observations from session 1 are still accessible
      const recent = getRecentObservations(db, 10, 'cross');
      expect(recent.length).toBe(1);
      expect(recent[0]!.session_id).toBe('e2e-cross-001');

      // Reasoning from session 1 is still accessible
      const reasoning = getRecentReasoning(db, 10, 'cross');
      expect(reasoning.length).toBe(1);
      expect(reasoning[0]!.title).toBe('Security audit conclusions');

      // Context assembly in session 2 includes session 1 data
      const assembled = assembleContext({
        hologram: null,
        searchResults: results,
        recentObservations: recent,
        reasoningChains: reasoning,
        scope: { type: 'project', name: 'cross', path: '/cross' },
      }, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('injection');
      expect(assembled.sources).toContain('fts5');
    });

    it('session 2 can find consensus decisions from session 1', () => {
      createSession(db, {
        session_id: 'e2e-cons-001',
        scope: 'project:cons',
        project: 'cons',
        cwd: '/cons',
      });

      insertConsensus(db, {
        session_id: 'e2e-cons-001',
        project: 'cons',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        title: 'Adopted microservices architecture',
        description: 'The team decided on microservices for independent deployment and scaling',
        status: 'agreed',
        importance: 5,
      });

      updateSessionStatus(db, 'e2e-cons-001', 'completed', new Date().toISOString());

      // Session 2
      createSession(db, {
        session_id: 'e2e-cons-002',
        scope: 'project:cons',
        project: 'cons',
        cwd: '/cons',
      });

      // Unified search finds consensus from session 1
      const results = searchAll(db, 'microservices');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.observation.title).toBe('Adopted microservices architecture');

      // Direct consensus retrieval
      const consensus = getRecentConsensus(db, 10, 'cons');
      expect(consensus.length).toBe(1);
      expect(consensus[0]!.status).toBe('agreed');
    });
  });

  describe('pressure scores persist across sessions', () => {
    it('scores written in session 1 are readable in session 2', () => {
      // Session 1: write pressure scores
      createSession(db, {
        session_id: 'e2e-pressure-001',
        scope: 'project:pressure',
        project: 'pressure',
        cwd: '/pressure',
      });

      upsertPressureScore(db, {
        file_path: 'src/auth/login.ts',
        project: 'pressure',
        raw_pressure: 0.95,
        temperature: 'HOT',
        last_accessed_epoch: Date.now(),
        decay_rate: 0.05,
      });

      upsertPressureScore(db, {
        file_path: 'src/utils/helpers.ts',
        project: 'pressure',
        raw_pressure: 0.45,
        temperature: 'WARM',
        last_accessed_epoch: Date.now(),
        decay_rate: 0.05,
      });

      upsertPressureScore(db, {
        file_path: 'README.md',
        project: 'pressure',
        raw_pressure: 0.1,
        temperature: 'COLD',
        last_accessed_epoch: Date.now(),
        decay_rate: 0.05,
      });

      updateSessionStatus(db, 'e2e-pressure-001', 'completed', new Date().toISOString());

      // Session 2: read pressure scores
      createSession(db, {
        session_id: 'e2e-pressure-002',
        scope: 'project:pressure',
        project: 'pressure',
        cwd: '/pressure',
      });

      const scores = getPressureScores(db, 'pressure');
      expect(scores.length).toBe(3);

      // Ordered by raw_pressure DESC
      expect(scores[0]!.file_path).toBe('src/auth/login.ts');
      expect(scores[0]!.temperature).toBe('HOT');
      expect(scores[0]!.raw_pressure).toBe(0.95);

      expect(scores[1]!.file_path).toBe('src/utils/helpers.ts');
      expect(scores[1]!.temperature).toBe('WARM');

      expect(scores[2]!.file_path).toBe('README.md');
      expect(scores[2]!.temperature).toBe('COLD');
    });

    it('pressure scores are upserted (not duplicated) on update', () => {
      createSession(db, {
        session_id: 'e2e-upsert-001',
        scope: 'project:upsert',
        project: 'upsert',
        cwd: '/upsert',
      });

      // Write initial score
      upsertPressureScore(db, {
        file_path: 'src/main.ts',
        project: 'upsert',
        raw_pressure: 0.5,
        temperature: 'WARM',
        decay_rate: 0.05,
      });

      // Update same file — should replace, not duplicate
      upsertPressureScore(db, {
        file_path: 'src/main.ts',
        project: 'upsert',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const scores = getPressureScores(db, 'upsert');
      expect(scores.length).toBe(1);
      expect(scores[0]!.raw_pressure).toBe(0.9);
      expect(scores[0]!.temperature).toBe('HOT');
    });
  });

  describe('context assembly integration', () => {
    it('assembles all data sources into coherent markdown', () => {
      createSession(db, {
        session_id: 'e2e-assembly-001',
        scope: 'project:assembly',
        project: 'assembly',
        cwd: '/assembly',
      });

      // Store observations
      storeObservation(db, makeObservation({
        session_id: 'e2e-assembly-001',
        project: 'assembly',
        title: 'Webpack configuration updated',
        content: 'Enabled tree shaking and code splitting for production builds',
        category: 'change',
      }));

      // Store reasoning
      insertReasoning(db, {
        session_id: 'e2e-assembly-001',
        project: 'assembly',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        trigger: 'pre_compact',
        title: 'Build optimization reasoning',
        reasoning: 'Chose webpack over rollup for broader plugin ecosystem',
        importance: 4,
      });

      // Store consensus
      insertConsensus(db, {
        session_id: 'e2e-assembly-001',
        project: 'assembly',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        title: 'Webpack as bundler',
        description: 'Team agreed on webpack for build tooling',
        status: 'agreed',
        importance: 4,
      });

      // Search for webpack-related content
      const searchResults = searchAll(db, 'webpack');

      // Assemble context with all sources
      const assembled = assembleContext({
        hologram: {
          hot: [{ path: 'webpack.config.js', raw_pressure: 0.95, temperature: 'HOT', system_bucket: 1, pressure_bucket: 1 }],
          warm: [{ path: 'package.json', raw_pressure: 0.5, temperature: 'WARM', system_bucket: 2, pressure_bucket: 2 }],
          cold: [],
        },
        searchResults,
        recentObservations: getRecentObservations(db, 5, 'assembly'),
        reasoningChains: getRecentReasoning(db, 5, 'assembly'),
        consensusDecisions: getRecentConsensus(db, 5, 'assembly'),
        scope: { type: 'project', name: 'assembly', path: '/assembly' },
      }, { maxTokens: 8000 });

      // Verify all sections are present
      expect(assembled.markdown).toContain('Context (auto-injected by Claudex)');
      expect(assembled.markdown).toContain('Active Focus');
      expect(assembled.markdown).toContain('webpack.config.js');
      expect(assembled.markdown).toContain('Flow Reasoning');
      expect(assembled.markdown).toContain('Build optimization reasoning');
      expect(assembled.markdown).toContain('Consensus Decisions');
      expect(assembled.markdown).toContain('Webpack as bundler');
      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('package.json');
      expect(assembled.tokenEstimate).toBeGreaterThan(0);

      // Verify contributing sources tracked
      expect(assembled.sources).toContain('hologram');
      expect(assembled.sources).toContain('reasoning');
      expect(assembled.sources).toContain('consensus');
    });

    it('respects token budget by omitting lower-priority sections', () => {
      createSession(db, {
        session_id: 'e2e-budget-001',
        scope: 'project:budget',
        project: 'budget',
        cwd: '/budget',
      });

      // Store a lot of content
      for (let i = 0; i < 20; i++) {
        storeObservation(db, makeObservation({
          session_id: 'e2e-budget-001',
          project: 'budget',
          title: `Performance observation ${i}`,
          content: `Detailed performance analysis number ${i} with lots of data about performance metrics and benchmarks`,
          category: 'discovery',
        }));
      }

      const searchResults = searchAll(db, 'performance');
      const recent = getRecentObservations(db, 20, 'budget');

      // Very small token budget — should truncate
      const assembled = assembleContext({
        hologram: null,
        searchResults,
        recentObservations: recent,
        scope: { type: 'project', name: 'budget', path: '/budget' },
      }, { maxTokens: 50 });

      // With such a small budget, some sections may be omitted
      expect(assembled.tokenEstimate).toBeLessThanOrEqual(50);
    });
  });

  describe('failed session handling', () => {
    it('session marked as failed does not appear as active', () => {
      createSession(db, {
        session_id: 'e2e-fail-001',
        scope: 'global',
        cwd: '/fail',
      });

      const active = getActiveSession(db);
      expect(active).not.toBeNull();

      updateSessionStatus(db, 'e2e-fail-001', 'failed', new Date().toISOString());

      const afterFail = getActiveSession(db);
      expect(afterFail).toBeNull();
    });

    it('observations from a failed session are still searchable', () => {
      createSession(db, {
        session_id: 'e2e-fail-002',
        scope: 'project:failsearch',
        project: 'failsearch',
        cwd: '/failsearch',
      });

      storeObservation(db, makeObservation({
        session_id: 'e2e-fail-002',
        project: 'failsearch',
        title: 'Discovered critical memory allocation issue',
        content: 'The allocator was leaking 2MB per request due to missing cleanup',
        importance: 5,
      }));

      updateSessionStatus(db, 'e2e-fail-002', 'failed', new Date().toISOString());

      // Data survives session failure
      const results = searchObservations(db, 'allocator');
      expect(results.length).toBe(1);
      expect(results[0]!.observation.title).toContain('memory allocation');
    });
  });

  describe('multi-project isolation', () => {
    it('observations are scoped to their project in filtered queries', () => {
      // Project A observations
      storeObservation(db, makeObservation({
        session_id: 'e2e-iso-001',
        project: 'alpha',
        title: 'Alpha logging setup',
        content: 'Configured Winston logger for alpha project',
      }));

      // Project B observations
      storeObservation(db, makeObservation({
        session_id: 'e2e-iso-002',
        project: 'beta',
        title: 'Beta logging setup',
        content: 'Configured Pino logger for beta project',
      }));

      // Project-scoped retrieval
      const alphaObs = getRecentObservations(db, 10, 'alpha');
      expect(alphaObs.length).toBe(1);
      expect(alphaObs[0]!.content).toContain('Winston');

      const betaObs = getRecentObservations(db, 10, 'beta');
      expect(betaObs.length).toBe(1);
      expect(betaObs[0]!.content).toContain('Pino');

      // Unscoped retrieval returns both
      const allObs = getRecentObservations(db, 10);
      expect(allObs.length).toBe(2);

      // Project-scoped search
      const alphaSearch = searchObservations(db, 'logging', { project: 'alpha' });
      expect(alphaSearch.length).toBe(1);
      expect(alphaSearch[0]!.observation.project).toBe('alpha');
    });

    it('pressure scores are scoped to their project', () => {
      upsertPressureScore(db, {
        file_path: 'src/index.ts',
        project: 'alpha',
        raw_pressure: 0.9,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      upsertPressureScore(db, {
        file_path: 'src/index.ts',
        project: 'beta',
        raw_pressure: 0.3,
        temperature: 'WARM',
        decay_rate: 0.05,
      });

      const alphaScores = getPressureScores(db, 'alpha');
      expect(alphaScores.length).toBe(1);
      expect(alphaScores[0]!.raw_pressure).toBe(0.9);

      const betaScores = getPressureScores(db, 'beta');
      expect(betaScores.length).toBe(1);
      expect(betaScores[0]!.raw_pressure).toBe(0.3);

      // Same file_path, different projects — both exist
      const allScores = getPressureScores(db);
      expect(allScores.length).toBe(2);
    });
  });
});
