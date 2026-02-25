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
