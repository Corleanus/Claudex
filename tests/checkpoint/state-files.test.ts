/**
 * Claudex v3 -- Incremental State I/O Tests
 *
 * Tests for src/checkpoint/state-files.ts.
 * Covers decisions, questions, files-touched, thread, archive,
 * cleanup, YAML fidelity, CRLF/BOM handling, and session isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Decision, FileState, ThreadState } from '../../src/checkpoint/types.js';

import {
  readDecisions,
  appendDecision,
  readQuestions,
  appendQuestion,
  readFilesTouched,
  recordFileTouch,
  readThread,
  appendExchange,
  updateThreadSummary,
  archiveStateFiles,
  cleanupOldArchives,
  validateSessionId,
  ensureDir,
} from '../../src/checkpoint/state-files.js';

// =============================================================================
// Test Helpers
// =============================================================================

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-files-test-'));
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/** Write raw content directly to a state file for testing edge cases */
function writeRawStateFile(
  projectDir: string,
  sessionId: string,
  fileName: string,
  content: string,
): void {
  const dir = path.join(projectDir, 'context', 'state', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content, 'utf-8');
}

// =============================================================================
// Setup / Teardown
// =============================================================================

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  cleanupTmpDir(tmpDir);
});

// =============================================================================
// Decisions
// =============================================================================

describe('decisions', () => {
  it('append decision then read back correctly', () => {
    const decision: Decision = {
      id: 'd1',
      what: 'Use tiered boost model',
      why: 'Prevents hard cutoff while prioritizing active work',
      when: '2026-02-24T14:15:00Z',
      reversible: true,
    };

    appendDecision(tmpDir, 'session-1', decision);
    const result = readDecisions(tmpDir, 'session-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(decision);
  });

  it('append multiple decisions preserves order', () => {
    const d1: Decision = { id: 'd1', what: 'First', why: 'Reason 1', when: '2026-02-24T14:00:00Z', reversible: true };
    const d2: Decision = { id: 'd2', what: 'Second', why: 'Reason 2', when: '2026-02-24T14:10:00Z', reversible: false };
    const d3: Decision = { id: 'd3', what: 'Third', why: 'Reason 3', when: '2026-02-24T14:20:00Z', reversible: true };

    appendDecision(tmpDir, 'session-1', d1);
    appendDecision(tmpDir, 'session-1', d2);
    appendDecision(tmpDir, 'session-1', d3);

    const result = readDecisions(tmpDir, 'session-1');
    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe('d1');
    expect(result[1]!.id).toBe('d2');
    expect(result[2]!.id).toBe('d3');
  });

  it('read from non-existent dir returns empty array', () => {
    const result = readDecisions(tmpDir, 'nonexistent-session');
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Questions
// =============================================================================

describe('questions', () => {
  it('append question then read back correctly', () => {
    appendQuestion(tmpDir, 'session-1', 'Should boost be 0.0x or 0.5x?');
    const result = readQuestions(tmpDir, 'session-1');

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Should boost be 0.0x or 0.5x?');
  });

  it('read from non-existent dir returns empty array', () => {
    const result = readQuestions(tmpDir, 'nonexistent-session');
    expect(result).toEqual([]);
  });
});

// =============================================================================
// Files Touched
// =============================================================================

describe('files touched', () => {
  it('accumulates file touches across multiple calls', () => {
    recordFileTouch(tmpDir, 'session-1', 'src/foo.ts', 'created', 'New module');
    recordFileTouch(tmpDir, 'session-1', 'src/bar.ts', 'modified', 'Updated imports');
    recordFileTouch(tmpDir, 'session-1', 'src/foo.ts', 'modified', 'Added export');

    const result = readFilesTouched(tmpDir, 'session-1');
    expect(result.changed).toHaveLength(3);
    // hot list is deduplicated
    expect(result.hot).toHaveLength(2);
    expect(result.hot).toContain('src/foo.ts');
    expect(result.hot).toContain('src/bar.ts');
  });

  it('read from non-existent dir returns empty FileState', () => {
    const result = readFilesTouched(tmpDir, 'nonexistent-session');
    expect(result.changed).toEqual([]);
    expect(result.read).toEqual([]);
    expect(result.hot).toEqual([]);
  });
});

// =============================================================================
// Thread
// =============================================================================

describe('thread', () => {
  it('exchange accumulation', () => {
    appendExchange(tmpDir, 'session-1', { role: 'user', gist: 'Implement scoring' });
    appendExchange(tmpDir, 'session-1', { role: 'agent', gist: 'Proposed tiered boost' });
    appendExchange(tmpDir, 'session-1', { role: 'user', gist: 'Approved' });

    const result = readThread(tmpDir, 'session-1');
    expect(result.key_exchanges).toHaveLength(3);
    expect(result.key_exchanges[0]!.role).toBe('user');
    expect(result.key_exchanges[1]!.role).toBe('agent');
    expect(result.key_exchanges[2]!.gist).toBe('Approved');
  });

  it('summary update overwrites without appending', () => {
    updateThreadSummary(tmpDir, 'session-1', 'Initial summary');
    updateThreadSummary(tmpDir, 'session-1', 'Updated summary');

    const result = readThread(tmpDir, 'session-1');
    expect(result.summary).toBe('Updated summary');
  });

  it('read from non-existent dir returns empty ThreadState', () => {
    const result = readThread(tmpDir, 'nonexistent-session');
    expect(result.summary).toBe('');
    expect(result.key_exchanges).toEqual([]);
  });
});

// =============================================================================
// Archive
// =============================================================================

describe('archiveStateFiles', () => {
  it('moves directory atomically', () => {
    appendDecision(tmpDir, 'session-1', {
      id: 'd1', what: 'Test', why: 'Testing', when: '2026-02-24T14:00:00Z', reversible: true,
    });

    const srcDir = path.join(tmpDir, 'context', 'state', 'session-1');
    expect(fs.existsSync(srcDir)).toBe(true);

    archiveStateFiles(tmpDir, 'session-1', '2026-02-24_cp1');

    expect(fs.existsSync(srcDir)).toBe(false);
    const archiveDir = path.join(tmpDir, 'context', 'state', 'archived', '2026-02-24_cp1');
    expect(fs.existsSync(archiveDir)).toBe(true);
  });

  it('archived dir structure preserved', () => {
    appendDecision(tmpDir, 'session-1', {
      id: 'd1', what: 'Test', why: 'Testing', when: '2026-02-24T14:00:00Z', reversible: true,
    });
    appendQuestion(tmpDir, 'session-1', 'Test question');

    archiveStateFiles(tmpDir, 'session-1', '2026-02-24_cp1');

    const archiveDir = path.join(tmpDir, 'context', 'state', 'archived', '2026-02-24_cp1');
    expect(fs.existsSync(path.join(archiveDir, 'decisions.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(archiveDir, 'questions.yaml'))).toBe(true);
  });

  it('does nothing when source dir does not exist', () => {
    // Should not throw
    expect(() => archiveStateFiles(tmpDir, 'nonexistent', 'cp1')).not.toThrow();
  });
});

// =============================================================================
// Cleanup Old Archives
// =============================================================================

describe('cleanupOldArchives', () => {
  it('respects maxAge', () => {
    // Create an archive directory
    const archiveDir = path.join(tmpDir, 'context', 'state', 'archived', 'old-cp');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'test.yaml'), 'data: true');

    // Set mtime to 10 days ago
    const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(archiveDir, new Date(tenDaysAgo), new Date(tenDaysAgo));

    // Cleanup with 7-day maxAge
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    cleanupOldArchives(tmpDir, sevenDaysMs);

    expect(fs.existsSync(archiveDir)).toBe(false);
  });

  it('does nothing when no archived dir exists', () => {
    expect(() => cleanupOldArchives(tmpDir, 1000)).not.toThrow();
  });
});

// =============================================================================
// YAML Round-Trip Fidelity
// =============================================================================

describe('YAML round-trip fidelity', () => {
  it('all types preserved through write-read cycle', () => {
    const decision: Decision = {
      id: 'd-special',
      what: 'String with "quotes" and \'apostrophes\'',
      why: 'Because: reasons & more',
      when: '2026-02-24T14:15:00Z',
      reversible: false,
    };

    appendDecision(tmpDir, 'session-1', decision);
    const result = readDecisions(tmpDir, 'session-1');

    expect(result[0]).toEqual(decision);
    expect(typeof result[0]!.reversible).toBe('boolean');
    expect(typeof result[0]!.id).toBe('string');
  });
});

// =============================================================================
// Corrupt YAML
// =============================================================================

describe('corrupt YAML', () => {
  it('returns empty array on corrupt decisions file', () => {
    writeRawStateFile(tmpDir, 'session-1', 'decisions.yaml', '{{{{invalid yaml::::');
    const result = readDecisions(tmpDir, 'session-1');
    expect(result).toEqual([]);
  });

  it('returns empty array on corrupt questions file', () => {
    writeRawStateFile(tmpDir, 'session-1', 'questions.yaml', 'not: [valid: yaml');
    const result = readQuestions(tmpDir, 'session-1');
    expect(result).toEqual([]);
  });

  it('returns empty FileState on corrupt files-touched', () => {
    writeRawStateFile(tmpDir, 'session-1', 'files-touched.yaml', '{broken');
    const result = readFilesTouched(tmpDir, 'session-1');
    expect(result.changed).toEqual([]);
    expect(result.read).toEqual([]);
    expect(result.hot).toEqual([]);
  });

  it('returns empty ThreadState on corrupt thread', () => {
    writeRawStateFile(tmpDir, 'session-1', 'thread.yaml', ':::invalid:::');
    const result = readThread(tmpDir, 'session-1');
    expect(result.summary).toBe('');
    expect(result.key_exchanges).toEqual([]);
  });
});

// =============================================================================
// CRLF + BOM Handling
// =============================================================================

describe('CRLF and BOM handling', () => {
  it('handles CRLF line endings in YAML', () => {
    const yamlContent = "- id: \"d1\"\r\n  what: \"CRLF test\"\r\n  why: \"Testing\"\r\n  when: \"2026-02-24T14:00:00Z\"\r\n  reversible: true\r\n";
    writeRawStateFile(tmpDir, 'session-1', 'decisions.yaml', yamlContent);

    const result = readDecisions(tmpDir, 'session-1');
    expect(result).toHaveLength(1);
    expect(result[0]!.what).toBe('CRLF test');
  });

  it('handles BOM in YAML files', () => {
    const bom = '\uFEFF';
    const yamlContent = bom + '- "BOM question"\n';
    writeRawStateFile(tmpDir, 'session-1', 'questions.yaml', yamlContent);

    const result = readQuestions(tmpDir, 'session-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('BOM question');
  });

  it('handles mixed line endings', () => {
    const yamlContent = "summary: \"Mixed endings\"\nkey_exchanges:\r\n  - role: \"user\"\n    gist: \"Test\"\r\n";
    writeRawStateFile(tmpDir, 'session-1', 'thread.yaml', yamlContent);

    const result = readThread(tmpDir, 'session-1');
    expect(result.summary).toBe('Mixed endings');
    expect(result.key_exchanges).toHaveLength(1);
  });
});

// =============================================================================
// Session Isolation
// =============================================================================

describe('session isolation', () => {
  it('two sessions do not see each other\'s state', () => {
    appendDecision(tmpDir, 'session-A', {
      id: 'dA', what: 'A decision', why: 'For A', when: '2026-02-24T14:00:00Z', reversible: true,
    });
    appendDecision(tmpDir, 'session-B', {
      id: 'dB', what: 'B decision', why: 'For B', when: '2026-02-24T14:01:00Z', reversible: false,
    });

    const resultA = readDecisions(tmpDir, 'session-A');
    const resultB = readDecisions(tmpDir, 'session-B');

    expect(resultA).toHaveLength(1);
    expect(resultA[0]!.id).toBe('dA');
    expect(resultB).toHaveLength(1);
    expect(resultB[0]!.id).toBe('dB');
  });

  it('concurrent append safety with separate sessions', () => {
    // Append to two different sessions rapidly
    for (let i = 0; i < 5; i++) {
      appendQuestion(tmpDir, 'session-X', `Question X-${i}`);
      appendQuestion(tmpDir, 'session-Y', `Question Y-${i}`);
    }

    const xQuestions = readQuestions(tmpDir, 'session-X');
    const yQuestions = readQuestions(tmpDir, 'session-Y');

    expect(xQuestions).toHaveLength(5);
    expect(yQuestions).toHaveLength(5);
    expect(xQuestions[0]).toBe('Question X-0');
    expect(yQuestions[4]).toBe('Question Y-4');
  });
});

// =============================================================================
// Atomic Writes (C07)
// =============================================================================

describe('atomic writes', () => {
  it('file exists and is valid YAML after appendDecision', () => {
    const decision: Decision = {
      id: 'atomic-1',
      what: 'Atomic test',
      why: 'Testing write-then-rename',
      when: '2026-03-01T00:00:00Z',
      reversible: true,
    };
    appendDecision(tmpDir, 'atomic-session', decision);

    const filePath = path.join(tmpDir, 'context', 'state', 'atomic-session', 'decisions.yaml');
    expect(fs.existsSync(filePath)).toBe(true);

    const result = readDecisions(tmpDir, 'atomic-session');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('atomic-1');
  });

  it('.tmp file does not persist after successful write', () => {
    appendDecision(tmpDir, 'tmp-check', {
      id: 'd1', what: 'Test', why: 'Tmp check', when: '2026-03-01T00:00:00Z', reversible: true,
    });

    const tmpPath = path.join(tmpDir, 'context', 'state', 'tmp-check', 'decisions.yaml.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('round-trip integrity: write then read back', () => {
    const decision: Decision = {
      id: 'round-trip',
      what: 'Test with "special" chars & symbols',
      why: 'Because: reasons',
      when: '2026-03-01T12:00:00Z',
      reversible: false,
    };
    appendDecision(tmpDir, 'rt-session', decision);

    const result = readDecisions(tmpDir, 'rt-session');
    expect(result[0]).toEqual(decision);
  });

  it('multiple sequential writes maintain data integrity', () => {
    for (let i = 0; i < 10; i++) {
      appendQuestion(tmpDir, 'seq-session', `Question ${i}`);
    }
    const questions = readQuestions(tmpDir, 'seq-session');
    expect(questions).toHaveLength(10);
    expect(questions[0]).toBe('Question 0');
    expect(questions[9]).toBe('Question 9');
  });
});

// =============================================================================
// session_id Validation and Path Containment (C03)
// =============================================================================

describe('session_id validation and path containment', () => {
  const decision: Decision = {
    id: 'd-test',
    what: 'Test decision',
    why: 'Testing path traversal',
    when: '2026-03-01T00:00:00Z',
    reversible: true,
  };

  // --- Path traversal rejection ---

  it('readDecisions returns empty for ../../../etc traversal', () => {
    const result = readDecisions(tmpDir, '../../../etc');
    expect(result).toEqual([]);
  });

  it('appendDecision with traversal writes inside state dir, not outside', () => {
    // Snapshot files before
    const stateRoot = path.join(tmpDir, 'context', 'state');
    appendDecision(tmpDir, '../../../tmp/evil', decision);
    // Sanitized ID is 'tmpevil' — should be inside state root
    const sanitizedDir = path.join(stateRoot, 'tmpevil');
    expect(fs.existsSync(sanitizedDir)).toBe(true);
    // No 'evil' directory at project root
    expect(fs.existsSync(path.join(tmpDir, 'evil'))).toBe(false);
  });

  it('readDecisions returns empty for backslash traversal', () => {
    const result = readDecisions(tmpDir, '..\\..\\..\\windows');
    expect(result).toEqual([]);
  });

  it('readDecisions returns empty for embedded traversal', () => {
    const result = readDecisions(tmpDir, 'valid-session/../../escape');
    expect(result).toEqual([]);
  });

  // --- Path containment enforcement ---

  it('appendDecision with ../escape does not create files outside state root', () => {
    appendDecision(tmpDir, '../escape', decision);
    expect(fs.existsSync(path.join(tmpDir, '..', 'escape'))).toBe(false);
  });

  // --- Safe session_id passthrough ---

  it('valid session_id round-trips correctly', () => {
    appendDecision(tmpDir, 'normal-session-123', decision);
    const result = readDecisions(tmpDir, 'normal-session-123');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('d-test');
  });

  it('max-length session_id (64 chars) works', () => {
    const longId = 'a'.repeat(64);
    appendDecision(tmpDir, longId, decision);
    const result = readDecisions(tmpDir, longId);
    expect(result).toHaveLength(1);
  });

  // --- validateSessionId ---

  it('validateSessionId accepts valid ID', () => {
    expect(validateSessionId('abc-123_test')).toBe(true);
  });

  it('validateSessionId rejects path traversal', () => {
    expect(validateSessionId('../etc')).toBe(false);
  });

  it('validateSessionId rejects empty string', () => {
    expect(validateSessionId('')).toBe(false);
  });

  it('validateSessionId rejects over 64 chars', () => {
    expect(validateSessionId('a'.repeat(65))).toBe(false);
  });

  it('validateSessionId rejects spaces', () => {
    expect(validateSessionId('has spaces')).toBe(false);
  });

  it('validateSessionId rejects slashes', () => {
    expect(validateSessionId('has/slash')).toBe(false);
  });
});

// =============================================================================
// R04: YAML element-level validation
// =============================================================================

describe('YAML element validation (R04)', () => {
  it('readQuestions filters non-string elements', () => {
    writeRawStateFile(tmpDir, 'r04-sess', 'questions.yaml',
      '- "valid question"\n- 123\n- null\n- nested: true\n');
    const result = readQuestions(tmpDir, 'r04-sess');
    expect(result).toEqual(['valid question']);
  });

  it('readDecisions filters entries missing required fields', () => {
    writeRawStateFile(tmpDir, 'r04-sess', 'decisions.yaml',
      '- id: "d1"\n  what: "Valid"\n  why: "Reason"\n  when: "2026-01-01"\n  reversible: true\n' +
      '- id: "d2"\n  what: null\n  why: "Reason"\n  when: "2026-01-01"\n  reversible: true\n' +
      '- 42\n' +
      '- id: "d3"\n  what: "Also valid"\n  why: "Another"\n  when: "2026-01-01"\n  reversible: false\n');
    const result = readDecisions(tmpDir, 'r04-sess');
    expect(result).toHaveLength(2);
    expect(result[0]!.what).toBe('Valid');
    expect(result[1]!.what).toBe('Also valid');
  });

  it('readThread filters key_exchanges missing gist or role', () => {
    writeRawStateFile(tmpDir, 'r04-sess', 'thread.yaml',
      'summary: "Test"\nkey_exchanges:\n' +
      '  - role: "user"\n    gist: "Valid"\n' +
      '  - role: "agent"\n' +
      '  - gist: "no role"\n' +
      '  - 42\n');
    const result = readThread(tmpDir, 'r04-sess');
    expect(result.key_exchanges).toHaveLength(1);
    expect(result.key_exchanges[0]!.gist).toBe('Valid');
  });

  it('readFilesTouched filters invalid changed entries', () => {
    writeRawStateFile(tmpDir, 'r04-sess', 'files-touched.yaml',
      'changed:\n' +
      '  - path: "src/a.ts"\n    action: "created"\n    summary: "New"\n' +
      '  - noPath: true\n' +
      '  - 42\n' +
      'read:\n  - "valid.ts"\n  - 123\n' +
      'hot:\n  - "hot.ts"\n  - null\n');
    const result = readFilesTouched(tmpDir, 'r04-sess');
    expect(result.changed).toHaveLength(1);
    expect(result.changed[0]!.path).toBe('src/a.ts');
    expect(result.read).toEqual(['valid.ts']);
    expect(result.hot).toEqual(['hot.ts']);
  });

  it('readQuestions returns empty for all-invalid elements', () => {
    writeRawStateFile(tmpDir, 'r04-sess', 'questions.yaml', '- 1\n- 2\n- 3\n');
    const result = readQuestions(tmpDir, 'r04-sess');
    expect(result).toEqual([]);
  });
});

// =============================================================================
// R29: Atomic write verification (already fixed, regression test)
// =============================================================================

describe('atomic write verification (R29)', () => {
  it('no .tmp file remains after safeWriteYaml', () => {
    appendDecision(tmpDir, 'atomic-r29', {
      id: 'd1', what: 'Test', why: 'Reason', when: '2026-01-01T00:00:00Z', reversible: true,
    });
    const tmpPath = path.join(tmpDir, 'context', 'state', 'atomic-r29', 'decisions.yaml.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);

    const mainPath = path.join(tmpDir, 'context', 'state', 'atomic-r29', 'decisions.yaml');
    expect(fs.existsSync(mainPath)).toBe(true);
    const content = fs.readFileSync(mainPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// R12: ensureDir creates directories with restricted permissions
// =============================================================================

describe('ensureDir permissions (R12)', () => {
  it('creates directory successfully', () => {
    const testDir = path.join(tmpDir, 'restricted-test', 'nested');
    ensureDir(testDir);
    expect(fs.existsSync(testDir)).toBe(true);
    expect(fs.statSync(testDir).isDirectory()).toBe(true);
  });

  it('passes mode 0o700 to mkdirSync on Unix', () => {
    // On Windows, mode is ignored by the OS, but the code should pass it.
    // On Unix, this test verifies the directory has owner-only permissions.
    if (process.platform !== 'win32') {
      const testDir = path.join(tmpDir, 'perm-test-dir');
      ensureDir(testDir);
      const stat = fs.statSync(testDir);
      // 0o700 = owner rwx only (may be further restricted by umask)
      const mode = stat.mode & 0o777;
      // mode should have no group/other permissions (umask may restrict further)
      expect(mode & 0o077).toBe(0);
    }
  });

  it('does not throw when directory already exists', () => {
    const testDir = path.join(tmpDir, 'existing-dir');
    fs.mkdirSync(testDir, { recursive: true });
    expect(() => ensureDir(testDir)).not.toThrow();
  });
});

// =============================================================================
// R13: Session ID sanitization warnings
// =============================================================================

describe('session ID sanitization (R13)', () => {
  it('operations still work with IDs that require sanitization', () => {
    // IDs with special chars get sanitized; operations should still succeed
    const decision: Decision = {
      id: 'd1', what: 'Test', why: 'Reason', when: '2026-01-01T00:00:00Z', reversible: true,
    };
    // Slashes get stripped, resulting in sanitized ID
    appendDecision(tmpDir, 'test/session', decision);
    // Reads using same raw ID should find the file (both sanitize to 'testsession')
    const result = readDecisions(tmpDir, 'test/session');
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('d1');
  });

  it('different raw IDs that sanitize to same value share state', () => {
    const d1: Decision = {
      id: 'd1', what: 'First', why: 'R1', when: '2026-01-01T00:00:00Z', reversible: true,
    };
    const d2: Decision = {
      id: 'd2', what: 'Second', why: 'R2', when: '2026-01-01T00:01:00Z', reversible: false,
    };
    // Both sanitize to 'ab' — this is the canonicalization collision the finding warns about
    appendDecision(tmpDir, 'a.b', d1);
    appendDecision(tmpDir, 'a/b', d2);
    // Both resolve to same dir, so both decisions are in the same file
    const result = readDecisions(tmpDir, 'ab');
    expect(result).toHaveLength(2);
  });

  it('clean session IDs pass through without issue', () => {
    const decision: Decision = {
      id: 'd1', what: 'Test', why: 'Reason', when: '2026-01-01T00:00:00Z', reversible: true,
    };
    appendDecision(tmpDir, 'clean-session-123', decision);
    const result = readDecisions(tmpDir, 'clean-session-123');
    expect(result).toHaveLength(1);
  });
});
