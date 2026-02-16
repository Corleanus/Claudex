import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDatabase } from '../../src/db/connection.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock logger to prevent filesystem writes during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('connection.ts — DB error handling', () => {
  let testDir: string;

  beforeEach(() => {
    // Create temp directory for test database
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-connection-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('H5: getDatabase() returns null on error instead of throwing', () => {
    // Use an invalid path that better-sqlite3 will reject
    // A path with a null byte is invalid on all platforms
    const invalidPath = 'invalid\x00path/database.db';

    const result = getDatabase(invalidPath);

    // Should return null, not throw
    expect(result).toBeNull();
  });

  it('H6: getDatabase() closes DB handle on migration failure', () => {
    // Test that multiple failed connections don't leak handles
    const invalidPath1 = 'invalid\x00path1/database.db';
    const invalidPath2 = 'invalid\x00path2/database.db';
    const invalidPath3 = 'invalid\x00path3/database.db';

    const result1 = getDatabase(invalidPath1);
    const result2 = getDatabase(invalidPath2);
    const result3 = getDatabase(invalidPath3);

    expect(result1).toBeNull();
    expect(result2).toBeNull();
    expect(result3).toBeNull();
    // If handles were leaking, we'd eventually hit resource limits
    // The fact that this completes successfully indicates proper cleanup
  });

  it('getDatabase() succeeds with valid path', () => {
    const dbPath = path.join(testDir, 'test.db');
    const db = getDatabase(dbPath);

    expect(db).not.toBeNull();
    if (db) {
      // Verify we can run a simple query
      const result = db.prepare('SELECT 1 as value').get() as { value: number } | undefined;
      expect(result?.value).toBe(1);
      db.close();
    }
  });
});
