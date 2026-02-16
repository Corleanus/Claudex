import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractObservation, redactSecrets } from '../../src/lib/observation-extractor.js';
import type { Scope } from '../../src/shared/types.js';

// Mock logger
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

const SESSION_ID = 'test-session-001';
const GLOBAL_SCOPE: Scope = { type: 'global' };
const PROJECT_SCOPE: Scope = { type: 'project', name: 'my-app', path: '/work/my-app' };

// Freeze time so timestamp assertions are stable
let dateSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.spyOn(Date.prototype, 'getTime').mockReturnValue(1700000000000);
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2023-11-14T22:13:20.000Z');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Per-tool extraction tests
// =============================================================================

describe('extractObservation', () => {
  describe('Read tool', () => {
    it('extracts observation from Read tool output', () => {
      const result = extractObservation(
        'Read',
        { file_path: '/src/index.ts' },
        { output: 'const x = 1;\nconst y = 2;\nconst z = 3;\n' },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Read');
      expect(result!.category).toBe('discovery');
      expect(result!.title).toContain('index.ts');
      expect(result!.files_read).toEqual(['/src/index.ts']);
    });
  });

  describe('Edit tool', () => {
    it('extracts observation from Edit tool output', () => {
      const result = extractObservation(
        'Edit',
        { file_path: '/src/utils.ts', old_string: 'foo', new_string: 'bar' },
        undefined,
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Edit');
      expect(result!.category).toBe('change');
      expect(result!.title).toContain('utils.ts');
      expect(result!.files_modified).toEqual(['/src/utils.ts']);
      expect(result!.content).toContain('foo');
      expect(result!.content).toContain('bar');
    });
  });

  describe('Write tool', () => {
    it('extracts observation from Write tool output', () => {
      const result = extractObservation(
        'Write',
        { file_path: '/src/new-file.tsx' },
        undefined,
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Write');
      expect(result!.category).toBe('feature');
      expect(result!.title).toContain('new-file.tsx');
      expect(result!.files_modified).toEqual(['/src/new-file.tsx']);
    });
  });

  describe('Bash tool', () => {
    it('extracts observation from Bash tool output', () => {
      const result = extractObservation(
        'Bash',
        { command: 'npm install express' },
        { exit_code: 0, output: 'added 57 packages' },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Bash');
      expect(result!.category).toBe('change');
      expect(result!.title).toContain('npm install express');
    });

    it('filters trivial Bash commands (ls) — returns null', () => {
      const result = extractObservation(
        'Bash',
        { command: 'ls' },
        { exit_code: 0, output: 'file1.txt\nfile2.txt' },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).toBeNull();
    });

    it('filters trivial Bash commands (cd) — returns null', () => {
      const result = extractObservation(
        'Bash',
        { command: 'cd /home/user' },
        { exit_code: 0 },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).toBeNull();
    });

    it('filters trivial Bash commands (pwd) — returns null', () => {
      const result = extractObservation(
        'Bash',
        { command: 'pwd' },
        { exit_code: 0, output: '/home/user' },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).toBeNull();
    });

    it('sets category to error when exit code is non-zero', () => {
      const result = extractObservation(
        'Bash',
        { command: 'npm test' },
        { exit_code: 1, stderr: 'Test failed' },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.category).toBe('error');
      expect(result!.importance).toBe(4);
    });
  });

  describe('Grep tool', () => {
    it('extracts observation from Grep tool output', () => {
      const result = extractObservation(
        'Grep',
        { pattern: 'TODO' },
        { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Grep');
      expect(result!.category).toBe('discovery');
      expect(result!.content).toContain('TODO');
      expect(result!.content).toContain('3');
    });
  });

  describe('Glob tool', () => {
    it('filters Glob results with < 3 matches — returns null', () => {
      const result = extractObservation(
        'Glob',
        { pattern: '*.ts' },
        { files: ['a.ts', 'b.ts'] },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).toBeNull();
    });

    it('returns observation for Glob with >= 3 matches', () => {
      const result = extractObservation(
        'Glob',
        { pattern: '*.ts' },
        { files: ['a.ts', 'b.ts', 'c.ts'] },
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).not.toBeNull();
      expect(result!.tool_name).toBe('Glob');
      expect(result!.category).toBe('discovery');
    });
  });

  describe('Unknown tools', () => {
    it('returns null for unhandled tool names', () => {
      const result = extractObservation(
        'UnknownTool',
        { foo: 'bar' },
        undefined,
        SESSION_ID,
        GLOBAL_SCOPE,
      );

      expect(result).toBeNull();
    });
  });
});

// =============================================================================
// Secret redaction tests
// =============================================================================

describe('redactSecrets', () => {
  it('redacts API keys from content', () => {
    const input = 'Config: api_key = sk-abc123xyz456789012345';
    const result = redactSecrets(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123xyz456789012345');
  });

  it('redacts API keys with various formats', () => {
    const inputs = [
      'token: ghp_ABCDEFghijklmnopqrstuvwxyz1234567890ab',
      'secret = "my-secret-value-here"',
      'api-key: some-long-value-here',
    ];

    for (const input of inputs) {
      const result = redactSecrets(input);
      expect(result).toContain('[REDACTED]');
    }
  });

  it('redacts JWT tokens', () => {
    // JWT format: eyJ<header>.eyJ<payload>.<signature>
    const jwt = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature';
    const result = redactSecrets(jwt);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0');
  });

  it('redacts AWS credentials', () => {
    const awsKey = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redactSecrets(awsKey);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redacts GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_)', () => {
    const ghToken = 'token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const result = redactSecrets(ghToken);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('does not redact normal text', () => {
    const normal = 'This is a perfectly normal sentence about coding.';
    expect(redactSecrets(normal)).toBe(normal);
  });

  it('handles multiple secrets in one string', () => {
    const multi = 'key1: api_key = secret123 and token: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab';
    const result = redactSecrets(multi);
    // Both should be redacted
    expect(result).toContain('[REDACTED]');
    // Exact original secrets should not survive
    expect(result).not.toContain('secret123');
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz1234567890ab');
  });
});

// =============================================================================
// Timestamp and importance tests
// =============================================================================

describe('observation metadata', () => {
  it('timestamp_epoch is in milliseconds (not seconds)', () => {
    const result = extractObservation(
      'Read',
      { file_path: '/src/index.ts' },
      { output: 'content' },
      SESSION_ID,
      GLOBAL_SCOPE,
    );

    expect(result).not.toBeNull();
    // Date.now() returns milliseconds — mocked to 1700000000000
    expect(result!.timestamp_epoch).toBe(1700000000000);
    // Sanity: epoch in ms should be > 1_000_000_000_000 (Sep 2001 in ms)
    expect(result!.timestamp_epoch).toBeGreaterThan(1_000_000_000_000);
  });

  it('importance field is set correctly per tool type', () => {
    // Read: importance 2
    const read = extractObservation(
      'Read',
      { file_path: '/a.ts' },
      { output: 'x' },
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(read!.importance).toBe(2);

    // Edit: importance 3
    const edit = extractObservation(
      'Edit',
      { file_path: '/a.ts', old_string: 'a', new_string: 'b' },
      undefined,
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(edit!.importance).toBe(3);

    // Write: importance 3
    const write = extractObservation(
      'Write',
      { file_path: '/a.ts' },
      undefined,
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(write!.importance).toBe(3);

    // Bash (success): importance 3
    const bash = extractObservation(
      'Bash',
      { command: 'npm install' },
      { exit_code: 0, output: 'ok' },
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(bash!.importance).toBe(3);

    // Bash (error): importance 4
    const bashErr = extractObservation(
      'Bash',
      { command: 'npm test' },
      { exit_code: 1 },
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(bashErr!.importance).toBe(4);

    // Grep: importance 2
    const grep = extractObservation(
      'Grep',
      { pattern: 'foo' },
      { files: ['a'] },
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(grep!.importance).toBe(2);

    // Glob (>= 3): importance 2
    const glob = extractObservation(
      'Glob',
      { pattern: '*.ts' },
      { files: ['a', 'b', 'c'] },
      SESSION_ID,
      GLOBAL_SCOPE,
    );
    expect(glob!.importance).toBe(2);
  });

  it('sets project field from scope', () => {
    const result = extractObservation(
      'Read',
      { file_path: '/src/index.ts' },
      { output: 'content' },
      SESSION_ID,
      PROJECT_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.project).toBe('my-app');
  });

  it('project is undefined for global scope', () => {
    const result = extractObservation(
      'Read',
      { file_path: '/src/index.ts' },
      { output: 'content' },
      SESSION_ID,
      GLOBAL_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.project).toBeUndefined();
  });
});

// =============================================================================
// Path sanitization in files_read/files_modified (C2 fix)
// =============================================================================

describe('path sanitization in observation fields', () => {
  it('sanitizes files_read paths to project-relative when in project scope', () => {
    const result = extractObservation(
      'Read',
      { file_path: '/work/my-app/src/index.ts' },
      { output: 'content' },
      SESSION_ID,
      PROJECT_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.files_read).toBeDefined();
    expect(result!.files_read![0]).toBe('<project>/src/index.ts');
    expect(result!.files_read![0]).not.toContain('/work/my-app');
  });

  it('sanitizes files_modified paths to project-relative when in project scope', () => {
    const result = extractObservation(
      'Edit',
      { file_path: '/work/my-app/src/utils.ts', old_string: 'foo', new_string: 'bar' },
      undefined,
      SESSION_ID,
      PROJECT_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.files_modified).toBeDefined();
    expect(result!.files_modified![0]).toBe('<project>/src/utils.ts');
  });

  it('redacts usernames in absolute paths when in global scope', () => {
    const result = extractObservation(
      'Read',
      { file_path: 'C:\\Users\\JohnDoe\\Desktop\\file.txt' },
      { output: 'content' },
      SESSION_ID,
      GLOBAL_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.files_read).toBeDefined();
    expect(result!.files_read![0]).toBe('C:\\Users\\[USER]\\Desktop\\file.txt');
    expect(result!.files_read![0]).not.toContain('JohnDoe');
  });

  it('redacts Unix usernames in files_modified', () => {
    const result = extractObservation(
      'Write',
      { file_path: '/home/alice/projects/file.js' },
      undefined,
      SESSION_ID,
      GLOBAL_SCOPE,
    );

    expect(result).not.toBeNull();
    expect(result!.files_modified).toBeDefined();
    expect(result!.files_modified![0]).toBe('/home/[USER]/projects/file.js');
    expect(result!.files_modified![0]).not.toContain('alice');
  });
});
