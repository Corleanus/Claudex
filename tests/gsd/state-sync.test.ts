/**
 * Claudex v2 -- State Sync Module Tests
 *
 * TDD tests for src/gsd/state-sync.ts.
 * Covers getClaudexMetrics (observation count, top files, coverage)
 * and writeClaudexMetricsToState (STATE.md section replacement).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import { storeObservation } from '../../src/db/observations.js';
import { getClaudexMetrics, writeClaudexMetricsToState } from '../../src/gsd/state-sync.js';

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

function insertObservation(
  database: Database.Database,
  project: string,
  opts?: { filesRead?: string[]; filesModified?: string[]; deleted?: boolean },
): void {
  const now = Date.now();
  storeObservation(database, {
    session_id: 'test-session',
    project,
    timestamp: new Date(now).toISOString(),
    timestamp_epoch: now,
    tool_name: 'Read',
    category: 'discovery',
    title: `obs-${Math.random().toString(36).slice(2, 8)}`,
    content: 'test content',
    importance: 3,
    files_read: opts?.filesRead,
    files_modified: opts?.filesModified,
  });

  if (opts?.deleted) {
    database.prepare(`
      UPDATE observations SET deleted_at_epoch = ?
      WHERE id = (SELECT MAX(id) FROM observations)
    `).run(now);
  }
}

function writeStateMd(projectDir: string, content: string): string {
  const planningDir = path.join(projectDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });
  const statePath = path.join(planningDir, 'STATE.md');
  fs.writeFileSync(statePath, content, 'utf-8');
  return statePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-state-sync-'));
  db = setupDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =========================================================================
// getClaudexMetrics
// =========================================================================

describe('getClaudexMetrics', () => {
  it('1. returns observation count for project', () => {
    insertObservation(db, 'test');
    insertObservation(db, 'test');
    insertObservation(db, 'test');
    insertObservation(db, 'other');
    insertObservation(db, 'other');

    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.observationCount).toBe(3);
  });

  it('2. excludes soft-deleted observations from count', () => {
    insertObservation(db, 'test');
    insertObservation(db, 'test', { deleted: true });

    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.observationCount).toBe(1);
  });

  it('3. returns top 5 HOT/WARM files by pressure', () => {
    // 3 HOT
    upsertPressureScore(db, { file_path: 'hot1.ts', project: 'test', raw_pressure: 0.95, temperature: 'HOT', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'hot2.ts', project: 'test', raw_pressure: 0.85, temperature: 'HOT', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'hot3.ts', project: 'test', raw_pressure: 0.75, temperature: 'HOT', decay_rate: 0.05 });
    // 2 WARM
    upsertPressureScore(db, { file_path: 'warm1.ts', project: 'test', raw_pressure: 0.55, temperature: 'WARM', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'warm2.ts', project: 'test', raw_pressure: 0.45, temperature: 'WARM', decay_rate: 0.05 });
    // 2 COLD
    upsertPressureScore(db, { file_path: 'cold1.ts', project: 'test', raw_pressure: 0.15, temperature: 'COLD', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'cold2.ts', project: 'test', raw_pressure: 0.10, temperature: 'COLD', decay_rate: 0.05 });

    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.topFiles).toHaveLength(5);
    // All should be HOT or WARM
    for (const f of metrics.topFiles) {
      expect(['HOT', 'WARM']).toContain(f.temperature);
    }
    // COLD files excluded
    const paths = metrics.topFiles.map(f => f.path);
    expect(paths).not.toContain('cold1.ts');
    expect(paths).not.toContain('cold2.ts');
    // Sorted by pressure descending
    for (let i = 1; i < metrics.topFiles.length; i++) {
      expect(metrics.topFiles[i - 1]!.pressure).toBeGreaterThanOrEqual(metrics.topFiles[i]!.pressure);
    }
  });

  it('4. caps topFiles at 5 entries', () => {
    for (let i = 0; i < 8; i++) {
      upsertPressureScore(db, {
        file_path: `hot${i}.ts`,
        project: 'test',
        raw_pressure: 0.9 - i * 0.01,
        temperature: 'HOT',
        decay_rate: 0.05,
      });
    }

    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.topFiles.length).toBe(5);
  });

  it('5. returns empty topFiles when no pressure scores exist', () => {
    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.topFiles).toHaveLength(0);
  });

  it('6. computes coverage percentage', () => {
    // Observations reference 4 distinct files
    insertObservation(db, 'test', { filesRead: ['a.ts', 'b.ts'], filesModified: ['c.ts'] });
    insertObservation(db, 'test', { filesRead: ['d.ts'] });

    // Pressure scores exist for 3 of those
    upsertPressureScore(db, { file_path: 'a.ts', project: 'test', raw_pressure: 0.8, temperature: 'HOT', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'b.ts', project: 'test', raw_pressure: 0.5, temperature: 'WARM', decay_rate: 0.05 });
    upsertPressureScore(db, { file_path: 'c.ts', project: 'test', raw_pressure: 0.3, temperature: 'WARM', decay_rate: 0.05 });

    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.coveragePct).toBe(75); // 3/4 = 75%
  });

  it('7. returns 0% coverage when no observations', () => {
    const metrics = getClaudexMetrics(db, 'test');
    expect(metrics.coveragePct).toBe(0);
  });

  it('8. returns valid ISO timestamp in updatedAt', () => {
    const metrics = getClaudexMetrics(db, 'test');
    const date = new Date(metrics.updatedAt);
    expect(date.toISOString()).toBe(metrics.updatedAt);
  });

  it('9. never throws on closed/invalid DB', () => {
    const closedDb = new Database(':memory:');
    closedDb.close();

    let metrics: ReturnType<typeof getClaudexMetrics> | undefined;
    expect(() => {
      metrics = getClaudexMetrics(closedDb, 'test');
    }).not.toThrow();

    expect(metrics).toBeDefined();
    expect(metrics!.observationCount).toBe(0);
    expect(metrics!.topFiles).toHaveLength(0);
    expect(metrics!.coveragePct).toBe(0);
  });
});

// =========================================================================
// writeClaudexMetricsToState
// =========================================================================

describe('writeClaudexMetricsToState', () => {
  it('10. replaces existing Claudex Metrics section', () => {
    writeStateMd(tmpDir, `## Current Position
Some content

## Claudex Metrics
<!-- AUTO-GENERATED by Claudex. Do not edit manually. -->
| Metric | Value |
|--------|-------|
| Observations | 50 |
| Updated | old |

## Session Continuity
More content
`);

    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Current Position');
    expect(content).toContain('## Session Continuity');
    expect(content).toContain('## Claudex Metrics');
    expect(content).not.toContain('| Observations | 50 |');
    expect(content).not.toContain('| Updated | old |');
  });

  it('11. appends Claudex Metrics section when missing', () => {
    writeStateMd(tmpDir, `## Current Position
Some content

## Session Continuity
More content
`);

    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
    // Should be appended at the end
    const metricsIdx = content.indexOf('## Claudex Metrics');
    const sessionIdx = content.indexOf('## Session Continuity');
    expect(metricsIdx).toBeGreaterThan(sessionIdx);
  });

  it('12. preserves CRLF line endings', () => {
    const crlfContent = '## Current Position\r\nSome content\r\n\r\n## Session Continuity\r\nMore content\r\n';
    writeStateMd(tmpDir, crlfContent);

    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');
    // Content outside the metrics section should retain CRLF
    const beforeMetrics = content.split('## Claudex Metrics')[0]!;
    expect(beforeMetrics).toContain('\r\n');
  });

  it('13. handles missing STATE.md gracefully', () => {
    // No .planning/STATE.md created
    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(false);

    // File should not have been created
    expect(fs.existsSync(path.join(tmpDir, '.planning', 'STATE.md'))).toBe(false);
  });

  it('14. atomic write (no partial content on crash)', () => {
    writeStateMd(tmpDir, '## Current Position\nSome content\n');

    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('## Claudex Metrics');

    // No .tmp file left behind
    const planningDir = path.join(tmpDir, '.planning');
    const files = fs.readdirSync(planningDir);
    const tmpFiles = files.filter(f => f.endsWith('.claudex-tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('15. metrics section contains expected fields', () => {
    writeStateMd(tmpDir, '## Current Position\nSome content\n');

    insertObservation(db, 'test');
    upsertPressureScore(db, { file_path: 'hot.ts', project: 'test', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 });

    const result = writeClaudexMetricsToState(tmpDir, 'test', db);
    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    expect(content).toContain('Observations');
    expect(content).toContain('Top Files');
    expect(content).toContain('Coverage');
    expect(content).toContain('Updated');
  });
});
