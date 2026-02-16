import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import { logAudit, getAuditLog, cleanOldAuditLogs } from '../../src/db/audit.js';
import type { AuditEntry } from '../../src/db/audit.js';

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

function makeEntry(overrides: Partial<Omit<AuditEntry, 'id' | 'created_at'>> = {}): Omit<AuditEntry, 'id' | 'created_at'> {
  return {
    timestamp: new Date().toISOString(),
    timestamp_epoch: Date.now(),
    session_id: 'sess-001',
    event_type: 'context_assembly',
    actor: 'hook:user-prompt-submit',
    details: { sources: ['fts5', 'hologram'], tokenEstimate: 1200 },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('audit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('logAudit', () => {
    it('inserts an audit entry', () => {
      logAudit(db, makeEntry());
      const rows = db.prepare('SELECT * FROM audit_log').all();
      expect(rows).toHaveLength(1);
    });

    it('stores all fields correctly', () => {
      const entry = makeEntry({
        session_id: 'sess-test',
        event_type: 'search',
        actor: 'hook:session-start',
        details: { query: 'test keyword', resultCount: 3 },
      });
      logAudit(db, entry);

      const rows = getAuditLog(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.session_id).toBe('sess-test');
      expect(rows[0]!.event_type).toBe('search');
      expect(rows[0]!.actor).toBe('hook:session-start');
      expect(rows[0]!.details).toEqual({ query: 'test keyword', resultCount: 3 });
      expect(rows[0]!.created_at).toBeTruthy();
    });

    it('handles null session_id', () => {
      logAudit(db, makeEntry({ session_id: null }));
      const rows = getAuditLog(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.session_id).toBeNull();
    });

    it('handles undefined session_id', () => {
      logAudit(db, makeEntry({ session_id: undefined }));
      const rows = getAuditLog(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.session_id).toBeNull();
    });

    it('handles no details', () => {
      logAudit(db, makeEntry({ details: undefined }));
      const rows = getAuditLog(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toBeUndefined();
    });

    it('never throws on DB error', () => {
      db.close();
      // Should not throw
      expect(() => logAudit(db, makeEntry())).not.toThrow();
    });

    it('redacts sensitive data in details', () => {
      logAudit(db, makeEntry({
        details: { apiKey: 'api_key=test_fake_secret_0123456789abcdef0123456789abcdef' },
      }));
      const raw = db.prepare('SELECT details FROM audit_log').get() as { details: string };
      expect(raw.details).toContain('[REDACTED]');
      expect(raw.details).not.toContain('test_fake_secret_0123456789abcdef0123456789abcdef');
    });

    it('caps details at 2000 chars', () => {
      const longValue = 'x'.repeat(3000);
      logAudit(db, makeEntry({
        details: { data: longValue },
      }));
      const raw = db.prepare('SELECT details FROM audit_log').get() as { details: string };
      expect(raw.details.length).toBeLessThanOrEqual(2000);
    });

    it('inserts multiple entries', () => {
      logAudit(db, makeEntry({ event_type: 'search' }));
      logAudit(db, makeEntry({ event_type: 'context_assembly' }));
      logAudit(db, makeEntry({ event_type: 'retention_cleanup' }));
      const rows = db.prepare('SELECT * FROM audit_log').all();
      expect(rows).toHaveLength(3);
    });
  });

  describe('getAuditLog', () => {
    it('returns all entries ordered by timestamp_epoch DESC', () => {
      const baseEpoch = Date.now();
      logAudit(db, makeEntry({ timestamp_epoch: baseEpoch - 2000 }));
      logAudit(db, makeEntry({ timestamp_epoch: baseEpoch }));
      logAudit(db, makeEntry({ timestamp_epoch: baseEpoch - 1000 }));

      const rows = getAuditLog(db);
      expect(rows).toHaveLength(3);
      expect(rows[0]!.timestamp_epoch).toBe(baseEpoch);
      expect(rows[2]!.timestamp_epoch).toBe(baseEpoch - 2000);
    });

    it('filters by sessionId', () => {
      logAudit(db, makeEntry({ session_id: 'sess-A' }));
      logAudit(db, makeEntry({ session_id: 'sess-B' }));
      logAudit(db, makeEntry({ session_id: 'sess-A' }));

      const rows = getAuditLog(db, { sessionId: 'sess-A' });
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.session_id === 'sess-A')).toBe(true);
    });

    it('filters by eventType', () => {
      logAudit(db, makeEntry({ event_type: 'search' }));
      logAudit(db, makeEntry({ event_type: 'context_assembly' }));
      logAudit(db, makeEntry({ event_type: 'search' }));

      const rows = getAuditLog(db, { eventType: 'search' });
      expect(rows).toHaveLength(2);
      expect(rows.every(r => r.event_type === 'search')).toBe(true);
    });

    it('filters by both sessionId and eventType', () => {
      logAudit(db, makeEntry({ session_id: 'sess-A', event_type: 'search' }));
      logAudit(db, makeEntry({ session_id: 'sess-A', event_type: 'context_assembly' }));
      logAudit(db, makeEntry({ session_id: 'sess-B', event_type: 'search' }));

      const rows = getAuditLog(db, { sessionId: 'sess-A', eventType: 'search' });
      expect(rows).toHaveLength(1);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        logAudit(db, makeEntry({ timestamp_epoch: Date.now() + i }));
      }

      const rows = getAuditLog(db, { limit: 3 });
      expect(rows).toHaveLength(3);
    });

    it('returns empty on empty DB', () => {
      const rows = getAuditLog(db);
      expect(rows).toEqual([]);
    });

    it('never throws on DB error', () => {
      db.close();
      const rows = getAuditLog(db);
      expect(rows).toEqual([]);
    });
  });

  describe('cleanOldAuditLogs', () => {
    it('deletes entries older than retentionDays', () => {
      const now = Date.now();
      const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);
      const twentyNineDaysAgo = now - (29 * 24 * 60 * 60 * 1000);

      logAudit(db, makeEntry({ timestamp_epoch: thirtyOneDaysAgo }));
      logAudit(db, makeEntry({ timestamp_epoch: twentyNineDaysAgo }));
      logAudit(db, makeEntry({ timestamp_epoch: now }));

      const deleted = cleanOldAuditLogs(db, 30);
      expect(deleted).toBe(1);

      const remaining = getAuditLog(db);
      expect(remaining).toHaveLength(2);
    });

    it('returns 0 when nothing to delete', () => {
      logAudit(db, makeEntry({ timestamp_epoch: Date.now() }));
      const deleted = cleanOldAuditLogs(db, 30);
      expect(deleted).toBe(0);
    });

    it('handles custom retention period', () => {
      const now = Date.now();
      const eightDaysAgo = now - (8 * 24 * 60 * 60 * 1000);
      const sixDaysAgo = now - (6 * 24 * 60 * 60 * 1000);

      logAudit(db, makeEntry({ timestamp_epoch: eightDaysAgo }));
      logAudit(db, makeEntry({ timestamp_epoch: sixDaysAgo }));

      const deleted = cleanOldAuditLogs(db, 7);
      expect(deleted).toBe(1);
    });

    it('handles empty DB', () => {
      const deleted = cleanOldAuditLogs(db, 30);
      expect(deleted).toBe(0);
    });

    it('never throws on DB error', () => {
      db.close();
      const deleted = cleanOldAuditLogs(db, 30);
      expect(deleted).toBe(0);
    });
  });

  describe('migration', () => {
    it('creates audit_log table with expected columns', () => {
      const info = db.prepare("PRAGMA table_info('audit_log')").all() as Array<{ name: string }>;
      const columns = info.map(c => c.name);
      expect(columns).toContain('id');
      expect(columns).toContain('timestamp');
      expect(columns).toContain('timestamp_epoch');
      expect(columns).toContain('session_id');
      expect(columns).toContain('event_type');
      expect(columns).toContain('actor');
      expect(columns).toContain('details');
      expect(columns).toContain('created_at');
    });

    it('creates indexes', () => {
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'").all() as Array<{ name: string }>;
      const names = indexes.map(i => i.name);
      expect(names).toContain('idx_audit_timestamp');
      expect(names).toContain('idx_audit_event_type');
      expect(names).toContain('idx_audit_session');
    });

    it('is idempotent', () => {
      // Running migrations again should not error
      const runner = new MigrationRunner(db);
      expect(() => runner.run()).not.toThrow();
    });
  });
});
