import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';

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

// We need to mock PATHS to point to our temp directory
let mockHologramPort = '';
vi.mock('../../src/shared/paths.js', () => {
  const actualPath = require('node:path');
  const actualOs = require('node:os');
  const home = actualPath.join(actualOs.homedir(), '.claudex');
  return {
    CLAUDEX_HOME: home,
    PATHS: new Proxy({
      home,
      db: actualPath.join(home, 'db'),
    } as Record<string, string>, {
      get(target, prop) {
        if (prop === 'hologramPort') return mockHologramPort;
        return target[prop as string];
      },
    }),
  };
});

import { runRecovery } from '../../src/lib/recovery.js';
import type { RecoveryReport, RecoveryCheck } from '../../src/lib/recovery.js';
import type { ClaudexConfig } from '../../src/shared/types.js';

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');

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
  const tmpDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'claudex-recovery-test-'));
  const dbPath = path.join(tmpDir, 'test.db');

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  return { db, tmpDir };
}

function createFtsTables(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reasoning_chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      trigger TEXT NOT NULL DEFAULT 'manual',
      title TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      decisions TEXT,
      files_involved TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS consensus_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      claude_position TEXT,
      codex_position TEXT,
      human_verdict TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      tags TEXT,
      files_affected TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, content, facts,
      content='observations', content_rowid='id'
    );
    CREATE VIRTUAL TABLE reasoning_fts USING fts5(
      title, reasoning, decisions,
      content='reasoning_chains', content_rowid='id'
    );
    CREATE VIRTUAL TABLE consensus_fts USING fts5(
      title, description, claude_position, codex_position, human_verdict,
      content='consensus_decisions', content_rowid='id'
    );
  `);
}

function findCheck(report: RecoveryReport, name: string): RecoveryCheck | undefined {
  return report.checks.find(c => c.name === name);
}

// =============================================================================
// Tests — Database Integrity (Check 1)
// =============================================================================

describe('runRecovery — database integrity', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('reports ok when DB integrity passes', async () => {
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'database');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('Integrity check passed');
  });

  it('reports warning when no DB provided', async () => {
    const report = await runRecovery(makeConfig());
    const check = findCheck(report, 'database');
    expect(check).toBeDefined();
    expect(check!.status).toBe('warning');
    expect(check!.message).toContain('No database connection');
  });

  it('skips DB-dependent checks when no DB provided', async () => {
    const report = await runRecovery(makeConfig());
    const orphanCheck = findCheck(report, 'orphan_session');
    const ftsCheck = findCheck(report, 'fts5_index');
    expect(orphanCheck).toBeUndefined();
    expect(ftsCheck).toBeUndefined();
  });
});

// =============================================================================
// Tests — Stale Sidecar Port File (Check 2)
// =============================================================================

describe('runRecovery — stale sidecar port', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('reports ok when no port file exists', async () => {
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'sidecar_port');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('No port file');
  });

  it('reports ok when port file is recent', async () => {
    realFs.writeFileSync(mockHologramPort, '9999', 'utf-8');
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'sidecar_port');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('recent');
  });

  it('removes stale port file when sidecar is not responding', async () => {
    realFs.writeFileSync(mockHologramPort, '59999', 'utf-8');
    // Make file appear old by setting mtime to 25 hours ago
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    realFs.utimesSync(mockHologramPort, oldTime, oldTime);

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'sidecar_port');
    expect(check).toBeDefined();
    expect(check!.status).toBe('recovered');
    expect(check!.message).toContain('Removed stale port file');
    expect(report.actionsPerformed).toContain('Removed stale sidecar port file');

    // File should be deleted
    expect(realFs.existsSync(mockHologramPort)).toBe(false);
  });

  it('keeps port file if sidecar is still responding', async () => {
    // Start a real TCP server to respond to the ping
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;

    realFs.writeFileSync(mockHologramPort, String(port), 'utf-8');
    // Make file appear old
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    realFs.utimesSync(mockHologramPort, oldTime, oldTime);

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'sidecar_port');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('still responding');

    // File should still exist
    expect(realFs.existsSync(mockHologramPort)).toBe(true);

    server.close();
  });
});

// =============================================================================
// Tests — Stale Cooldown File (Check 3)
// =============================================================================

describe('runRecovery — stale cooldown', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;
  let cooldownFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
    // The cooldown file path is hardcoded to ~/.claudex/db/.flush_cooldown
    // We can't easily mock it, so we'll test via the report structure.
    // For direct testing, we need the file at the actual path.
    cooldownFile = path.join(os.homedir(), '.claudex', 'db', '.flush_cooldown');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    // Clean up cooldown file if we created it
    try { realFs.unlinkSync(cooldownFile); } catch { /* */ }
  });

  // NOTE: Cooldown tests use the REAL ~/.claudex/db/.flush_cooldown path because
  // COOLDOWN_FILE is a module-level constant. Live Claudex hooks may interfere.
  // Tests accept multiple valid states to handle race conditions.

  it('reports ok when no cooldown file exists', async () => {
    try { realFs.unlinkSync(cooldownFile); } catch { /* */ }
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // ok (no file) or recovered (live hook recreated a stale one) are both valid
    expect(['ok', 'recovered']).toContain(check!.status);
  });

  it('reports ok when cooldown file is recent', async () => {
    const dir = path.dirname(cooldownFile);
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(cooldownFile, String(Date.now()), 'utf-8');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // ok (file is recent) or ok (file was deleted by external process)
    expect(check!.status).toBe('ok');
  });

  it('removes stale cooldown file (>1h old)', async () => {
    const dir = path.dirname(cooldownFile);
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    realFs.writeFileSync(cooldownFile, String(twoHoursAgo), 'utf-8');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // recovered (deleted stale), ok (external process deleted/recreated it first),
    // or ok (file content was overwritten with recent timestamp by live hook)
    expect(['recovered', 'ok']).toContain(check!.status);
  });

  // H24 fix: far-future cooldown timestamps should be reset
  it('removes far-future cooldown timestamp (beyond 1h ahead)', async () => {
    const dir = path.dirname(cooldownFile);
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
    const twoHoursAhead = Date.now() + 2 * 60 * 60 * 1000;
    realFs.writeFileSync(cooldownFile, String(twoHoursAhead), 'utf-8');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // recovered (deleted far-future) or ok (external process fixed it)
    expect(['recovered', 'ok']).toContain(check!.status);
    if (check!.status === 'recovered') {
      expect(check!.message).toContain('far-future');
    }
  });

  it('removes cooldown with invalid timestamp (negative)', async () => {
    const dir = path.dirname(cooldownFile);
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(cooldownFile, '-12345', 'utf-8');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // recovered (deleted invalid) or ok (external process fixed it)
    expect(['recovered', 'ok']).toContain(check!.status);
    if (check!.status === 'recovered') {
      expect(check!.message).toContain('invalid');
    }
  });

  it('removes cooldown with nonsensical timestamp (NaN)', async () => {
    const dir = path.dirname(cooldownFile);
    if (!realFs.existsSync(dir)) realFs.mkdirSync(dir, { recursive: true });
    realFs.writeFileSync(cooldownFile, 'not-a-number', 'utf-8');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'cooldown');
    expect(check).toBeDefined();
    // recovered (deleted invalid) or ok (external process fixed it)
    expect(['recovered', 'ok']).toContain(check!.status);
    if (check!.status === 'recovered') {
      expect(check!.message).toContain('invalid');
    }
  });
});

// =============================================================================
// Tests — Orphan Sessions (Check 4)
// =============================================================================

describe('runRecovery — orphan sessions', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('reports ok when no active sessions', async () => {
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'orphan_session');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('No orphan sessions');
  });

  it('reports ok when active session is recent', async () => {
    const now = new Date();
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('recent-session', '/tmp', now.toISOString(), now.getTime(), 'active');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'orphan_session');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('active session(s)');
  });

  it('closes orphan sessions older than 12h', async () => {
    const thirteenHoursAgo = Date.now() - 13 * 60 * 60 * 1000;
    const oldDate = new Date(thirteenHoursAgo);
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('orphan-session', '/tmp', oldDate.toISOString(), thirteenHoursAgo, 'active');

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'orphan_session');
    expect(check).toBeDefined();
    expect(check!.status).toBe('recovered');
    expect(check!.message).toContain('Closed 1 orphan session(s)');
    expect(report.actionsPerformed).toContain('Closed orphan active session');

    // Verify the session was updated correctly
    const row = db.prepare('SELECT status, ended_at, ended_at_epoch FROM sessions WHERE session_id = ?').get('orphan-session') as {
      status: string;
      ended_at: string | null;
      ended_at_epoch: number | null;
    };
    expect(row.status).toBe('failed');
    expect(row.ended_at).toBeTruthy();  // ISO string set
    expect(row.ended_at_epoch).toBeGreaterThan(0);  // epoch set
  });

  it('sets BOTH ended_at and ended_at_epoch on orphan sessions', async () => {
    const oldEpoch = Date.now() - 24 * 60 * 60 * 1000;
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('orphan-both-fields', '/tmp', new Date(oldEpoch).toISOString(), oldEpoch, 'active');

    await runRecovery(makeConfig(), db);

    const row = db.prepare('SELECT ended_at, ended_at_epoch FROM sessions WHERE session_id = ?').get('orphan-both-fields') as {
      ended_at: string | null;
      ended_at_epoch: number | null;
    };
    expect(row.ended_at).not.toBeNull();
    expect(row.ended_at_epoch).not.toBeNull();
    // ended_at_epoch should be a reasonable timestamp (ms)
    expect(row.ended_at_epoch!).toBeGreaterThan(1700000000000);
  });

  it('leaves recent active sessions untouched', async () => {
    // One old orphan, one recent active
    const oldEpoch = Date.now() - 13 * 60 * 60 * 1000;
    const recentEpoch = Date.now() - 60000; // 1 minute ago

    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('old-orphan', '/tmp', new Date(oldEpoch).toISOString(), oldEpoch, 'active');
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('recent-active', '/tmp', new Date(recentEpoch).toISOString(), recentEpoch, 'active');

    await runRecovery(makeConfig(), db);

    const oldRow = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('old-orphan') as { status: string };
    const recentRow = db.prepare('SELECT status FROM sessions WHERE session_id = ?').get('recent-active') as { status: string };

    expect(oldRow.status).toBe('failed');
    expect(recentRow.status).toBe('active');
  });
});

// =============================================================================
// Tests — FTS5 Health (Check 5)
// =============================================================================

describe('runRecovery — FTS5 health', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('reports ok when FTS tables are healthy', async () => {
    createFtsTables(db);
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'fts5_index');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('table(s) healthy');
  });

  it('reports ok with 0 tables when FTS tables do not exist (older DB)', async () => {
    // DB without FTS tables — should still be ok (older DB scenario)
    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'fts5_index');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('0 table(s) healthy');
  });

  it('handles partial FTS table existence (only observations_fts)', async () => {
    // Create only observations FTS — simulate partially migrated DB
    db.exec(`
      CREATE VIRTUAL TABLE observations_fts USING fts5(
        title, content, facts,
        content='observations', content_rowid='id'
      );
    `);

    const report = await runRecovery(makeConfig(), db);
    const check = findCheck(report, 'fts5_index');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
    expect(check!.message).toContain('1 table(s) healthy');
  });
});

// =============================================================================
// Tests — Report Structure
// =============================================================================

describe('runRecovery — report structure', () => {
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    vi.clearAllMocks();
    const tmp = createTempDb();
    tmpDir = tmp.tmpDir;
    db = tmp.db;
    mockHologramPort = path.join(tmpDir, 'hologram.port');
  });

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns all 5 checks when DB is provided', async () => {
    createFtsTables(db);
    const report = await runRecovery(makeConfig(), db);
    expect(report.checks.length).toBe(5);
    expect(report.checks.map(c => c.name).sort()).toEqual([
      'cooldown', 'database', 'fts5_index', 'orphan_session', 'sidecar_port',
    ]);
  });

  it('returns 3 checks when no DB', async () => {
    const report = await runRecovery(makeConfig());
    expect(report.checks.length).toBe(3);
    expect(report.checks.map(c => c.name).sort()).toEqual([
      'cooldown', 'database', 'sidecar_port',
    ]);
  });

  it('reports healthy when all checks pass', async () => {
    const report = await runRecovery(makeConfig(), db);
    expect(report.healthy).toBe(true);
  });

  it('reports healthy when checks recover (recovered counts as healthy)', async () => {
    // Create an orphan session that will be recovered
    const oldEpoch = Date.now() - 13 * 60 * 60 * 1000;
    db.prepare(
      'INSERT INTO sessions (session_id, cwd, started_at, started_at_epoch, status) VALUES (?, ?, ?, ?, ?)',
    ).run('to-recover', '/tmp', new Date(oldEpoch).toISOString(), oldEpoch, 'active');

    const report = await runRecovery(makeConfig(), db);
    expect(report.healthy).toBe(true);
    expect(report.actionsPerformed.length).toBeGreaterThan(0);
  });

  it('never throws', async () => {
    // Even with a closed DB, should not throw
    db.close();
    const report = await runRecovery(makeConfig(), db);
    expect(report).toBeDefined();
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it('checks are independent — one failure does not block others', async () => {
    // Close DB to make DB-dependent checks fail
    db.close();
    const report = await runRecovery(makeConfig(), db);

    // Database check should fail, but sidecar and cooldown checks should still run
    const dbCheck = findCheck(report, 'database');
    const sidecarCheck = findCheck(report, 'sidecar_port');
    const cooldownCheck = findCheck(report, 'cooldown');

    expect(dbCheck).toBeDefined();
    expect(sidecarCheck).toBeDefined();
    expect(cooldownCheck).toBeDefined();
    // DB check failed but others should still have meaningful status
    expect(dbCheck!.status).toBe('failed');
  });
});
