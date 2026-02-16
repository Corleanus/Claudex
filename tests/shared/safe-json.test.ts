/**
 * Claudex v2 — Safe JSON parsing tests
 */

import { describe, it, expect, vi } from 'vitest';
import { safeJsonParse } from '../../src/shared/safe-json.js';

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('safeJsonParse', () => {
  it('should parse valid JSON successfully', () => {
    const raw = '{"key": "value", "num": 42}';
    const result = safeJsonParse<Record<string, unknown>>(raw, {});

    expect(result).toEqual({ key: 'value', num: 42 });
  });

  it('should parse valid JSON array successfully', () => {
    const raw = '["a", "b", "c"]';
    const result = safeJsonParse<string[]>(raw, []);

    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('should return fallback for malformed JSON', () => {
    const raw = '{"key": "value"'; // missing closing brace
    const fallback = { _error: true };
    const result = safeJsonParse<Record<string, unknown>>(raw, fallback);

    expect(result).toEqual(fallback);
  });

  it('should return fallback for truncated JSON', () => {
    const raw = '{"key": "val'; // truncated string
    const fallback = { _raw: raw };
    const result = safeJsonParse<Record<string, unknown>>(raw, fallback);

    expect(result).toEqual(fallback);
  });

  it('should return fallback for empty string', () => {
    const raw = '';
    const fallback: string[] = [];
    const result = safeJsonParse<string[]>(raw, fallback);

    expect(result).toEqual(fallback);
  });

  it('should return fallback for garbage data', () => {
    const raw = 'not json at all!';
    const fallback = { _default: true };
    const result = safeJsonParse<Record<string, unknown>>(raw, fallback);

    expect(result).toEqual(fallback);
  });

  it('should preserve fallback reference on error', () => {
    const raw = 'invalid';
    const fallback = { _preserved: 'yes' };
    const result = safeJsonParse<Record<string, unknown>>(raw, fallback);

    expect(result).toBe(fallback); // same reference
  });

  it('should handle valid nested JSON', () => {
    const raw = '{"outer": {"inner": [1, 2, 3]}}';
    const result = safeJsonParse<Record<string, unknown>>(raw, {});

    expect(result).toEqual({ outer: { inner: [1, 2, 3] } });
  });
});
