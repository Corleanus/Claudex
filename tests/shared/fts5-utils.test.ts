import { describe, it, expect } from 'vitest';
import { normalizeFts5Query } from '../../src/shared/fts5-utils.js';

describe('normalizeFts5Query', () => {
  it('replaces hyphens with spaces', () => {
    expect(normalizeFts5Query('tree-shaking')).toBe('tree shaking');
    expect(normalizeFts5Query('error-handling')).toBe('error handling');
    expect(normalizeFts5Query('pre-commit')).toBe('pre commit');
  });

  it('strips parentheses', () => {
    expect(normalizeFts5Query('(typescript OR javascript)')).toBe('typescript OR javascript');
    expect(normalizeFts5Query('foo (bar)')).toBe('foo bar');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeFts5Query('foo   bar')).toBe('foo bar');
    expect(normalizeFts5Query('tree-  -shaking')).toBe('tree shaking');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeFts5Query('  typescript  ')).toBe('typescript');
    expect(normalizeFts5Query('\ttree-shaking\n')).toBe('tree shaking');
  });

  it('preserves quotes for phrase searches', () => {
    expect(normalizeFts5Query('"exact phrase"')).toBe('"exact phrase"');
  });

  it('preserves asterisk for prefix searches', () => {
    expect(normalizeFts5Query('type*')).toBe('type*');
  });

  it('preserves colon for column filters', () => {
    expect(normalizeFts5Query('title:refactor')).toBe('title:refactor');
  });

  it('handles complex queries with mixed special characters', () => {
    expect(normalizeFts5Query('(tree-shaking) AND build*')).toBe('tree shaking AND build*');
    expect(normalizeFts5Query('title:error-handling OR "async/await"')).toBe('title:error handling OR "async/await"');
  });

  it('handles empty strings', () => {
    expect(normalizeFts5Query('')).toBe('');
    expect(normalizeFts5Query('   ')).toBe('');
  });

  it('preserves uppercase (FTS5 is case-insensitive)', () => {
    expect(normalizeFts5Query('TypeScript')).toBe('TypeScript');
    expect(normalizeFts5Query('TREE-SHAKING')).toBe('TREE SHAKING');
  });

  describe('OR mode', () => {
    it('joins terms with OR when mode is OR', () => {
      expect(normalizeFts5Query('typescript errors', { mode: 'OR' })).toBe('typescript OR errors');
    });

    it('preserves existing operators in OR mode', () => {
      // AND is a FTS5 operator — preserved as-is, no OR inserted around it
      expect(normalizeFts5Query('typescript AND errors', { mode: 'OR' })).toBe('typescript AND errors');
    });

    it('handles single term in OR mode (no OR needed)', () => {
      expect(normalizeFts5Query('typescript', { mode: 'OR' })).toBe('typescript');
    });

    it('handles hyphenated terms in OR mode', () => {
      expect(normalizeFts5Query('tree-shaking build', { mode: 'OR' })).toBe('tree OR shaking OR build');
    });
  });

  describe('prefix matching', () => {
    it('appends * to short terms (< 6 chars) when prefix is true', () => {
      expect(normalizeFts5Query('err', { prefix: true })).toBe('err*');
      expect(normalizeFts5Query('type', { prefix: true })).toBe('type*');
      expect(normalizeFts5Query('build', { prefix: true })).toBe('build*');
    });

    it('does not append * to long terms (>= 6 chars)', () => {
      expect(normalizeFts5Query('typescript', { prefix: true })).toBe('typescript');
      expect(normalizeFts5Query('refactor', { prefix: true })).toBe('refactor');
    });

    it('does not append * to terms that already have it', () => {
      expect(normalizeFts5Query('type*', { prefix: true })).toBe('type*');
    });

    it('does not append * to FTS5 operators', () => {
      expect(normalizeFts5Query('err AND big', { prefix: true })).toBe('err* AND big*');
    });

    it('does not append * to column filters', () => {
      expect(normalizeFts5Query('title:err', { prefix: true })).toBe('title:err');
    });

    it('combines prefix with OR mode', () => {
      expect(normalizeFts5Query('err fix', { mode: 'OR', prefix: true })).toBe('err* OR fix*');
    });
  });
});
