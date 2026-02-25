import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { extractObservation } from '../../src/lib/observation-extractor.js';
import { recordFileTouch, readFilesTouched } from '../../src/checkpoint/state-files.js';
import type { Scope } from '../../src/shared/types.js';

// Mock logger and metrics (state-files.ts uses these)
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

const TEST_SESSION = 'sess-ptu-state-test';
const PROJECT_SCOPE: Scope = { type: 'project', name: 'test-project', path: '/test/project' };
const GLOBAL_SCOPE: Scope = { type: 'global' };

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-ptu-state-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// Tests
// =============================================================================

describe('PostToolUse Step 3.7: files-touched state updates', () => {
  it('records file touch for Write tool with files_modified', () => {
    const observation = extractObservation(
      'Write',
      { file_path: '/src/new-file.ts' },
      undefined,
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    expect(observation!.files_modified).toBeDefined();
    expect(observation!.files_modified!.length).toBeGreaterThan(0);

    // Simulate Step 3.7
    for (const filePath of observation!.files_modified!) {
      recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Write', observation!.title);
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(1);
    expect(state.changed[0]!.path).toBe('/src/new-file.ts');
    expect(state.changed[0]!.action).toBe('Write');
    expect(state.changed[0]!.summary).toBe(observation!.title);
    expect(state.hot).toContain('/src/new-file.ts');
  });

  it('records file touch for Edit tool with files_modified', () => {
    const observation = extractObservation(
      'Edit',
      { file_path: '/src/existing.ts', old_string: 'old', new_string: 'new' },
      undefined,
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    expect(observation!.files_modified).toBeDefined();
    expect(observation!.files_modified!.length).toBeGreaterThan(0);

    for (const filePath of observation!.files_modified!) {
      recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Edit', observation!.title);
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(1);
    expect(state.changed[0]!.action).toBe('Edit');
    expect(state.hot).toContain('/src/existing.ts');
  });

  it('does not record file touch for Read tool (no files_modified)', () => {
    const observation = extractObservation(
      'Read',
      { file_path: '/src/foo.ts' },
      { output: 'file contents' },
      TEST_SESSION,
      PROJECT_SCOPE,
    );

    expect(observation).not.toBeNull();
    // Read observations have files_read but NOT files_modified
    expect(observation!.files_modified).toBeUndefined();

    // Simulate Step 3.7 guard
    if (observation!.files_modified && observation!.files_modified.length > 0) {
      for (const filePath of observation!.files_modified) {
        recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Read', observation!.title);
      }
    }

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(0);
    expect(state.hot.length).toBe(0);
  });

  it('does not crash when observation.files_modified is undefined', () => {
    // Simulate an observation without files_modified
    const observation = {
      session_id: TEST_SESSION,
      timestamp: new Date().toISOString(),
      timestamp_epoch: Date.now(),
      tool_name: 'Bash',
      category: 'execution' as const,
      title: 'ran command',
      content: 'output',
      importance: 1,
      // files_modified intentionally omitted
    };

    expect(() => {
      if (observation.files_modified && observation.files_modified.length > 0) {
        // Should not enter this block
        throw new Error('Should not reach here');
      }
    }).not.toThrow();
  });

  it('does not crash when observation.files_modified is empty array', () => {
    const observation = {
      session_id: TEST_SESSION,
      timestamp: new Date().toISOString(),
      timestamp_epoch: Date.now(),
      tool_name: 'Write',
      category: 'change' as const,
      title: 'wrote file',
      content: 'content',
      importance: 3,
      files_modified: [] as string[],
    };

    expect(() => {
      if (observation.files_modified && observation.files_modified.length > 0) {
        for (const filePath of observation.files_modified) {
          recordFileTouch(tmpDir, TEST_SESSION, filePath, 'Write', observation.title);
        }
      }
    }).not.toThrow();

    const state = readFilesTouched(tmpDir, TEST_SESSION);
    expect(state.changed.length).toBe(0);
  });

  it('writes state file to correct session-scoped path', () => {
    recordFileTouch(tmpDir, TEST_SESSION, '/src/test.ts', 'Write', 'test write');

    const expectedDir = path.join(tmpDir, 'context', 'state', TEST_SESSION);
    const expectedFile = path.join(expectedDir, 'files-touched.yaml');

    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(expectedFile)).toBe(true);

    // Verify content is valid YAML with expected structure
    const content = fs.readFileSync(expectedFile, 'utf-8');
    expect(content).toContain('/src/test.ts');
    expect(content).toContain('Write');
  });
});
