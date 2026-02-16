import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import type { ClaudexConfig } from '../../src/shared/types.js';
import type { MetricEntry } from '../../src/shared/metrics.js';

// =============================================================================
// Mocks
// =============================================================================

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/shared/metrics.js', () => ({
  getMetrics: vi.fn(() => ({})),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((...args: unknown[]) =>
      (actual.existsSync as (...a: unknown[]) => boolean)(...args),
    ),
    readFileSync: vi.fn((...args: unknown[]) =>
      (actual.readFileSync as (...a: unknown[]) => unknown)(...args),
    ),
  };
});

const mockExistsSync = fs.existsSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

import { getMetrics } from '../../src/shared/metrics.js';
import { checkHealth } from '../../src/shared/health.js';

const mockGetMetrics = getMetrics as ReturnType<typeof vi.fn>;

// =============================================================================
// Helpers
// =============================================================================

function makeConfig(overrides: Partial<ClaudexConfig> = {}): ClaudexConfig {
  return {
    hologram: { enabled: false, timeout_ms: 2000, health_interval_ms: 30000 },
    wrapper: { enabled: true, warnThreshold: 0.7, flushThreshold: 0.8, cooldownMs: 30000 },
    ...overrides,
  };
}

function createTempDb(): { db: InstanceType<typeof Database>; tmpDir: string } {
  const tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'claudex-health-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      tool_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'discovery',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      facts TEXT,
      files_read TEXT,
      files_modified TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      project TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      project TEXT,
      cwd TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      ended_at TEXT,
      ended_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      observation_count INTEGER NOT NULL DEFAULT 0
    );
  `);

  const now = new Date().toISOString();
  const ins = db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)');
  ins.run(1, now);
  ins.run(2, now);
  ins.run(3, now);
  ins.run(4, now);

  return { db, tmpDir };
}

function seedDb(db: InstanceType<typeof Database>, obsCount: number, sessCount: number): void {
  const now = new Date().toISOString();
  const epoch = Date.now();
  for (let i = 0; i < obsCount; i++) {
    db.prepare(
      'INSERT INTO observations (session_id, timestamp, timestamp_epoch, title, content) VALUES (?, ?, ?, ?, ?)',
    ).run(`sess-obs-${i}`, now, epoch, `obs-${i}`, `content-${i}`);
  }
  for (let i = 0; i < sessCount; i++) {
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch) VALUES (?, ?, ?, ?)',
    ).run(`sess-${i}`, '/tmp', now, epoch);
  }
}

function resetFsMocksToReal(): void {
  mockExistsSync.mockImplementation((...args: unknown[]) =>
    (realFs.existsSync as (...a: unknown[]) => boolean)(...args),
  );
  mockReadFileSync.mockImplementation((...args: unknown[]) =>
    (realFs.readFileSync as (...a: unknown[]) => unknown)(...args),
  );
}

// =============================================================================
// Tests — Database (using real SQLite via db parameter)
// =============================================================================

describe('checkHealth — database', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetrics.mockReturnValue({});
    resetFsMocksToReal();

    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
  });

  afterEach(() => {
    try { db.close(); } catch { /* non-fatal */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  });

  it('reports database ok when DB is provided', async () => {
    const report = await checkHealth(makeConfig(), db);
    expect(report.database.ok).toBe(true);
  });

  it('reports database ok when no DB provided (dynamic import fallback succeeds)', async () => {
    const report = await checkHealth(makeConfig());
    // With async dynamic import, the fallback now works in tests
    expect(report.database.ok).toBe(true);
    expect(report.database.observationCount).toBeGreaterThanOrEqual(0);
    expect(report.database.sessionCount).toBeGreaterThanOrEqual(0);
  });

  it('reports observation and session counts', async () => {
    seedDb(db, 42, 7);
    const report = await checkHealth(makeConfig(), db);
    expect(report.database.observationCount).toBe(42);
    expect(report.database.sessionCount).toBe(7);
  });

  it('reports zero counts on empty database', async () => {
    const report = await checkHealth(makeConfig(), db);
    expect(report.database.observationCount).toBe(0);
    expect(report.database.sessionCount).toBe(0);
  });
});

// =============================================================================
// Tests — Hologram, Wrapper, Metrics
// =============================================================================

describe('checkHealth — hologram, wrapper, metrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMetrics.mockReturnValue({});
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('');
  });

  it('reports hologram ok when port file exists and enabled', async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('hologram.port')) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('9876');

    const config = makeConfig({
      hologram: { enabled: true, timeout_ms: 2000, health_interval_ms: 30000 },
    });

    const report = await checkHealth(config);
    expect(report.hologram.ok).toBe(true);
    expect(report.hologram.port).toBe(9876);
  });

  it('reports hologram not ok when disabled', async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('hologram.port')) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('9876');

    const config = makeConfig({
      hologram: { enabled: false, timeout_ms: 2000, health_interval_ms: 30000 },
    });

    const report = await checkHealth(config);
    expect(report.hologram.ok).toBe(false);
    expect(report.hologram.port).toBe(9876);
  });

  it('reports hologram port as null when port file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const config = makeConfig({
      hologram: { enabled: true, timeout_ms: 2000, health_interval_ms: 30000 },
    });

    const report = await checkHealth(config);
    expect(report.hologram.ok).toBe(false);
    expect(report.hologram.port).toBeNull();
  });

  it('reports wrapper enabled status from config', async () => {
    const enabledReport = await checkHealth(
      makeConfig({ wrapper: { enabled: true, warnThreshold: 0.7, flushThreshold: 0.8, cooldownMs: 30000 } }),
    );
    expect(enabledReport.wrapper.enabled).toBe(true);

    const disabledReport = await checkHealth(
      makeConfig({ wrapper: { enabled: false, warnThreshold: 0.7, flushThreshold: 0.8, cooldownMs: 30000 } }),
    );
    expect(disabledReport.wrapper.enabled).toBe(false);
  });

  it('reads lastFlushEpoch from cooldown file when it exists', async () => {
    mockExistsSync.mockImplementation((p: unknown) => {
      if (typeof p === 'string' && p.includes('.flush_cooldown')) return true;
      return false;
    });
    mockReadFileSync.mockReturnValue('1707936000000');

    const report = await checkHealth(makeConfig());
    expect(report.wrapper.lastFlushEpoch).toBe(1707936000000);
  });

  it('reports lastFlushEpoch as 0 when cooldown file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const report = await checkHealth(makeConfig());
    expect(report.wrapper.lastFlushEpoch).toBe(0);
  });

  it('includes metrics in report', async () => {
    const fakeMetrics: Record<string, MetricEntry> = {
      'db.query': { name: 'db.query', count: 5, totalMs: 100, lastMs: 20, errors: 1 },
    };
    mockGetMetrics.mockReturnValue(fakeMetrics);

    const report = await checkHealth(makeConfig());
    expect(report.metrics).toBe(fakeMetrics);
    expect(report.metrics['db.query']!.count).toBe(5);
  });

  it('handles all failures gracefully — never throws', async () => {
    mockExistsSync.mockImplementation(() => { throw new Error('FS exploded'); });
    mockGetMetrics.mockReturnValue({});

    await expect(checkHealth(makeConfig())).resolves.toBeDefined();
    const report = await checkHealth(makeConfig());
    expect(report.database.ok).toBe(false);
    expect(report.hologram.ok).toBe(false);
    expect(report.wrapper).toBeDefined();
  });
});
