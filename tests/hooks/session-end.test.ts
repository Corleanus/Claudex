import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

// =============================================================================
// R25: Single DB connection test
// =============================================================================

describe('session-end hook - R25: single DB connection', () => {
  it('session-end.ts source uses getDatabase() at most once', () => {
    // Read session-end.ts source and count getDatabase() calls
    // After R25 fix, there should be exactly 1 getDatabase() call
    const source = fs.readFileSync(
      new URL('../../src/hooks/session-end.ts', import.meta.url),
      'utf-8',
    );

    // Count actual getDatabase() invocations (not imports or type references)
    // Pattern: getDatabase() with parens, but not inside import statements
    const lines = source.split('\n');
    let callCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip import lines and type annotations
      if (trimmed.startsWith('import') || trimmed.startsWith('const {') || trimmed.startsWith('//')) continue;
      // Count actual invocations: db = getDatabase() or similar
      const matches = trimmed.match(/getDatabase\(\)/g);
      if (matches) callCount += matches.length;
    }

    expect(callCount).toBeLessThanOrEqual(1);
  });

  it('session-end.ts has a single db.close() in a finally block', () => {
    const source = fs.readFileSync(
      new URL('../../src/hooks/session-end.ts', import.meta.url),
      'utf-8',
    );

    // Count db.close() calls — should be exactly 1 (in finally block)
    const closeMatches = source.match(/db\.close\(\)/g) || [];
    expect(closeMatches.length).toBe(1);

    // Verify it's in a finally block
    expect(source).toContain('finally');
    // The close should be near a finally
    const finallyIdx = source.lastIndexOf('finally');
    const closeIdx = source.indexOf('db.close()', finallyIdx);
    expect(closeIdx).toBeGreaterThan(finallyIdx);
  });
});

describe('session-end hook - error handling', () => {
  describe('H14: Retention audit error logging', () => {
    it('verifies audit functions never throw (follow "never throw" pattern)', async () => {
      // H14 fix: changed empty catch {} to catch (auditErr) { logToFile(...) }
      // This test verifies that audit functions follow the "never throw" pattern,
      // so errors are caught and logged internally rather than propagating.

      const { logAudit, cleanOldAuditLogs } = await import('../../src/db/audit.js');

      // Mock database that will cause internal errors (prepare will fail)
      const mockDb = {
        prepare: () => {
          throw new Error('Database connection lost');
        },
        close: () => {},
      } as any;

      // Both functions should NOT throw - they catch errors internally
      expect(() => {
        logAudit(mockDb, {
          timestamp: new Date().toISOString(),
          timestamp_epoch: Date.now(),
          session_id: 'test-session',
          event_type: 'retention_cleanup',
          actor: 'hook:session-end',
          details: { test: true },
        });
      }).not.toThrow();

      expect(() => {
        cleanOldAuditLogs(mockDb, 30);
      }).not.toThrow();

      // The H14 fix ensures that when audit operations fail in session-end.ts,
      // the error is logged via logToFile() instead of being silently swallowed.
      // The pattern is: try { logAudit(); cleanOldAuditLogs(); } catch (auditErr) { logToFile(); }
    });
  });

  describe('H13: Path sanitization integration', () => {
    it('transcriptDir sanitizes session_id before filesystem operations', async () => {
      const { transcriptDir } = await import('../../src/shared/paths.js');

      // Test that path traversal attempts are sanitized
      const maliciousId = '../../etc/passwd';
      const result = transcriptDir(maliciousId);

      // Should not contain path traversal sequences
      expect(result).not.toContain('..');
      expect(result).not.toContain('/etc/');
      expect(result).toMatch(/transcripts[\/\\]etcpasswd$/);
    });

    it('completionMarkerPath sanitizes session_id', async () => {
      const { completionMarkerPath } = await import('../../src/shared/paths.js');

      const maliciousId = '../../../tmp/exploit';
      const result = completionMarkerPath(maliciousId);

      expect(result).not.toContain('..');
      expect(result).not.toContain('/tmp/');
      expect(result).toMatch(/\.completed-tmpexploit$/);
    });

    it('sessionDir sanitizes session_id', async () => {
      const { sessionDir } = await import('../../src/shared/paths.js');

      const maliciousId = '..\\..\\windows\\system32';
      const result = sessionDir(maliciousId);

      expect(result).not.toContain('..');
      // path.join() may add platform separators, but the session_id part should not have them
      expect(result).not.toContain('windows\\system32');
      expect(result).not.toContain('/windows/');
      expect(result).toMatch(/sessions[\/\\]windowssystem32$/);
    });

    it('globalSessionLogPath sanitizes session_id', async () => {
      const { globalSessionLogPath } = await import('../../src/shared/paths.js');

      const maliciousId = '../../../../etc/shadow';
      const result = globalSessionLogPath(maliciousId);

      expect(result).not.toContain('..');
      expect(result).toMatch(/sessions[\/\\]etcshadow\.md$/);
    });
  });
});
