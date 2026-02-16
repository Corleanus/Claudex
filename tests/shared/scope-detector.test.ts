import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { detectScope, normalizePath } from '../../src/shared/scope-detector.js';

// Mock the logger to avoid filesystem side effects during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock fs — we control what readFileSync returns
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
  };
});

const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockReadFileSync.mockReset();
});

// =============================================================================
// normalizePath unit tests
// =============================================================================

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\Dev\\project')).toBe(
      process.platform === 'win32' ? 'c:/users/dev/project' : 'C:/Users/Dev/project'
    );
  });

  it('strips trailing slashes', () => {
    expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
    expect(normalizePath('/home/user/project///')).toBe('/home/user/project');
  });

  it('lowercases the entire path on Windows only', () => {
    const input = '/Home/USER/Project';
    const result = normalizePath(input);
    if (process.platform === 'win32') {
      expect(result).toBe('/home/user/project');
    } else {
      expect(result).toBe('/Home/USER/Project');
    }
  });

  it('handles mixed separators', () => {
    expect(normalizePath('C:\\Users/Dev\\project/')).toBe(
      process.platform === 'win32' ? 'c:/users/dev/project' : 'C:/Users/Dev/project'
    );
  });

  it('preserves case on Unix-like systems', () => {
    const input = '/home/User/MyProject';
    const result = normalizePath(input);
    if (process.platform === 'win32') {
      expect(result).toBe('/home/user/myproject');
    } else {
      expect(result).toBe('/home/User/MyProject');
    }
  });
});

// =============================================================================
// detectScope tests
// =============================================================================

describe('detectScope', () => {
  it('returns global scope when no projects.json exists (readFileSync throws)', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = detectScope('/some/random/path');
    expect(result).toEqual({ type: 'global' });
  });

  it('returns global scope when cwd does not match any project path', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp', status: 'active' },
      },
    }));

    const result = detectScope('C:\\Other\\Directory');
    expect(result).toEqual({ type: 'global' });
  });

  it('returns project scope when cwd matches a project path exactly', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp', status: 'active' },
      },
    }));

    const result = detectScope('C:\\Work\\MyApp');
    expect(result).toEqual({
      type: 'project',
      name: 'my-app',
      path: 'C:\\Work\\MyApp',
    });
  });

  it('returns project scope when cwd is a subdirectory of a project path', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp', status: 'active' },
      },
    }));

    const result = detectScope('C:\\Work\\MyApp\\src\\lib');
    expect(result).toEqual({
      type: 'project',
      name: 'my-app',
      path: 'C:\\Work\\MyApp',
    });
  });

  it('handles Windows backslashes vs forward slashes (path normalization)', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp', status: 'active' },
      },
    }));

    // Query with forward slashes should still match a backslash-stored path
    const result = detectScope('C:/Work/MyApp/src');
    expect(result).toEqual({
      type: 'project',
      name: 'my-app',
      path: 'C:\\Work\\MyApp',
    });
  });

  it('boundary check: C:\\Work\\App does NOT match C:\\Work\\App-archive', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\App', status: 'active' },
      },
    }));

    const result = detectScope('C:\\Work\\App-archive');
    expect(result).toEqual({ type: 'global' });
  });

  it('boundary check: C:\\Work\\App matches C:\\Work\\App\\subdir but not C:\\Work\\AppX', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\App', status: 'active' },
      },
    }));

    const matchResult = detectScope('C:\\Work\\App\\subdir');
    expect(matchResult.type).toBe('project');

    const noMatchResult = detectScope('C:\\Work\\AppX');
    expect(noMatchResult).toEqual({ type: 'global' });
  });

  it('case-insensitive matching on Windows', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp', status: 'active' },
      },
    }));

    const result = detectScope('c:\\work\\myapp\\src');
    expect(result).toEqual({
      type: 'project',
      name: 'my-app',
      path: 'C:\\Work\\MyApp',
    });
  });

  it('handles trailing slashes consistently', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'my-app': { path: 'C:\\Work\\MyApp\\', status: 'active' },
      },
    }));

    // The project path has a trailing backslash — should still match
    const result = detectScope('C:\\Work\\MyApp');
    expect(result).toEqual({
      type: 'project',
      name: 'my-app',
      path: 'C:\\Work\\MyApp\\',
    });
  });

  it('returns global scope when projects.json contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('this is not JSON');

    const result = detectScope('/any/path');
    expect(result).toEqual({ type: 'global' });
  });

  it('returns global scope when projects.json has no "projects" key', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 1 }));

    const result = detectScope('/any/path');
    expect(result).toEqual({ type: 'global' });
  });

  it('skips project entries with missing path', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({
      projects: {
        'broken': { status: 'active' },
        'valid': { path: '/home/user/valid', status: 'active' },
      },
    }));

    const result = detectScope('/home/user/valid/src');
    expect(result).toEqual({
      type: 'project',
      name: 'valid',
      path: '/home/user/valid',
    });
  });
});
