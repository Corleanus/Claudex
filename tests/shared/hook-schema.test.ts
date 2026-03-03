import { describe, it, expect } from 'vitest';
import {
  detectVersion,
  migrateInput,
  stampOutput,
  validateInput,
  CURRENT_SCHEMA_VERSION,
} from '../../src/shared/hook-schema.js';

describe('detectVersion', () => {
  it('returns schema_version when present', () => {
    expect(detectVersion({ schema_version: 2 })).toBe(2);
  });

  it('returns 1 when schema_version is absent', () => {
    expect(detectVersion({ session_id: 'test' })).toBe(1);
  });

  it('returns 1 when schema_version is not a number', () => {
    expect(detectVersion({ schema_version: 'two' })).toBe(1);
  });
});

describe('migrateInput', () => {
  it('stamps schema_version when migrating from v1', () => {
    const result = migrateInput({ session_id: 'test' }, 1);
    expect(result.schema_version).toBe(2);
  });

  it('preserves existing fields during migration', () => {
    const input = { session_id: 'test', cwd: '/tmp' };
    const result = migrateInput(input, 1);
    expect(result.session_id).toBe('test');
    expect(result.cwd).toBe('/tmp');
  });
});

describe('stampOutput', () => {
  it('adds schema_version to output', () => {
    const result = stampOutput({ some: 'data' });
    expect(result.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('preserves existing output fields', () => {
    const result = stampOutput({ key: 'value' });
    expect(result.key).toBe('value');
  });
});

describe('validateInput — session_id format (O08)', () => {
  it('accepts valid alphanumeric session_id', () => {
    const result = validateInput('test', { session_id: 'abc123' }, 2);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts session_id with hyphens and underscores', () => {
    const result = validateInput('test', { session_id: 'sess-123_abc' }, 2);
    expect(result.valid).toBe(true);
  });

  it('rejects missing session_id', () => {
    const result = validateInput('test', {}, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Missing');
  });

  it('rejects empty string session_id', () => {
    const result = validateInput('test', { session_id: '' }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Missing');
  });

  it('rejects whitespace-only session_id', () => {
    const result = validateInput('test', { session_id: '   ' }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid format');
  });

  it('rejects session_id with path traversal', () => {
    const result = validateInput('test', { session_id: '../../../etc/passwd' }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid format');
  });

  it('rejects session_id with special characters', () => {
    const result = validateInput('test', { session_id: 'id;rm -rf /' }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid format');
  });

  it('rejects session_id with slashes', () => {
    const result = validateInput('test', { session_id: 'path/to/file' }, 2);
    expect(result.valid).toBe(false);
  });

  it('rejects session_id that is too long (>128 chars)', () => {
    const longId = 'a'.repeat(129);
    const result = validateInput('test', { session_id: longId }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('invalid format');
  });

  it('accepts session_id at max length (128 chars)', () => {
    const maxId = 'a'.repeat(128);
    const result = validateInput('test', { session_id: maxId }, 2);
    expect(result.valid).toBe(true);
  });

  it('rejects non-string session_id', () => {
    const result = validateInput('test', { session_id: 12345 }, 2);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be a string');
  });
});
