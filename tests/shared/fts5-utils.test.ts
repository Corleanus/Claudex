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
});
