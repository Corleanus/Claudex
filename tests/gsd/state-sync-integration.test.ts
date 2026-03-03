/**
 * Claudex v2 -- State Sync Integration Tests
 *
 * Verifies that metrics appear in STATE.md after handler invocations
 * and that the wired writeClaudexMetricsToState calls work end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { storeObservation } from '../../src/db/observations.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import {
  handlePhaseStart,
  handlePhaseEnd,
  handlePlanComplete,
} from '../../src/gsd/phase-transition.js';
import { writeClaudexMetricsToState } from '../../src/gsd/state-sync.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let tmpDir: string;
let db: Database.Database;

function setupDb(): Database.Database {
  const database = new Database(':memory:');
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const runner = new MigrationRunner(database);
  runner.run();
  return database;
}

function writeGsdFiles(projectDir: string, opts?: { phase?: number; plan?: number }): void {
  const phase = opts?.phase ?? 6;
  const plan = opts?.plan ?? 1;
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  const stateContent = `# Project State

Phase: ${phase} of 8 (Phase Transition Hooks)
Plan: ${plan} of 2
Status: Executing
`;
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), stateContent, 'utf-8');

  const roadmapContent = `# Roadmap

## Phase 5: Cross-Phase Intelligence
**Goal**: Cross-phase pattern detection
**Depends on**: Phase 4
**Requirements**: SUMM-03
**Success Criteria**:
  1. Cross-phase summary exists

## Phase 6: Phase Transition Hooks
**Goal**: Lifecycle handlers
**Depends on**: Phase 5
**Requirements**: LIFE-01, LIFE-02, LIFE-03
**Success Criteria**:
  1. Handlers execute correctly
`;
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmapContent, 'utf-8');

  fs.mkdirSync(path.join(planningDir, 'phases', '05-cross-phase-intelligence'), { recursive: true });
  fs.mkdirSync(path.join(planningDir, 'phases', '06-phase-transition-hooks'), { recursive: true });
}

function insertObservations(database: Database.Database, project: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const now = Date.now();
    storeObservation(database, {
      session_id: 'test-session',
      project,
      timestamp: new Date(now).toISOString(),
      timestamp_epoch: now,
      tool_name: 'Read',
      category: 'discovery',
      title: `obs-${i}`,
      content: 'test',
      importance: 3,
      files_read: [`file-${i}.ts`],
    });
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-state-sync-int-'));
  db = setupDb();
  writeGsdFiles(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('state-sync integration', () => {
  it('1. handlePhaseStart writes metrics to STATE.md', () => {
    insertObservations(db, 'project-a', 3);
    upsertPressureScore(db, { file_path: 'hot.ts', project: 'project-a', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 });

    const result = handlePhaseStart({ db, projectDir: tmpDir, projectName: 'project-a', phaseNumber: 6 });
    expect(result.success).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
  });

  it('2. handlePhaseEnd writes metrics to STATE.md', () => {
    insertObservations(db, 'project-a', 2);

    const result = handlePhaseEnd({ db, projectDir: tmpDir, projectName: 'project-a', phaseNumber: 6 });
    expect(result.success).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
  });

  it('3. handlePlanComplete writes metrics to STATE.md', () => {
    const result = handlePlanComplete({
      db,
      projectDir: tmpDir,
      projectName: 'project-a',
      phaseNumber: 6,
      planNumber: 1,
      sessionId: 'session-test',
    });
    expect(result.success).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
  });

  it('4. metrics section has correct observation count', () => {
    insertObservations(db, 'project-a', 5);

    handlePhaseStart({ db, projectDir: tmpDir, projectName: 'project-a', phaseNumber: 6 });

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('| Observations | 5 |');
  });

  it('5. metrics section preserves other STATE.md content', () => {
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    fs.writeFileSync(statePath, `## Current Position
Phase 6 of 8

## Session Continuity
Some notes here
`, 'utf-8');

    handlePhaseStart({ db, projectDir: tmpDir, projectName: 'project-a', phaseNumber: 6 });

    const content = fs.readFileSync(statePath, 'utf-8');
    expect(content).toContain('## Current Position');
    expect(content).toContain('## Session Continuity');
    expect(content).toContain('## Claudex Metrics');
  });

  it('6. writeClaudexMetricsToState has no internal debounce', () => {
    const result1 = writeClaudexMetricsToState(tmpDir, 'project-a', db);
    expect(result1).toBe(true);

    const result2 = writeClaudexMetricsToState(tmpDir, 'project-a', db);
    expect(result2).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
  });

  it('7. missing STATE.md does not break handler', () => {
    // Remove STATE.md
    fs.unlinkSync(path.join(tmpDir, '.planning', 'STATE.md'));

    // Handler should still succeed (metrics write silently returns false)
    const result = handlePhaseStart({ db, projectDir: tmpDir, projectName: 'project-a', phaseNumber: 6 });
    expect(result.success).toBe(true);
  });
});
