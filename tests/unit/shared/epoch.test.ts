/**
 * Claudex v2 — Epoch Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import { ensureEpochMs } from '../../../src/shared/epoch.js';

describe('ensureEpochMs', () => {
  it('should convert seconds to milliseconds when value < 1e12', () => {
    // Unix timestamp for 2021-01-01 00:00:00 UTC in seconds
    const secondsEpoch = 1609459200;
    const expected = 1609459200000;
    expect(ensureEpochMs(secondsEpoch)).toBe(expected);
  });

  it('should return milliseconds as-is when value >= 1e12', () => {
    // Unix timestamp for 2021-01-01 00:00:00 UTC in milliseconds
    const msEpoch = 1609459200000;
    expect(ensureEpochMs(msEpoch)).toBe(msEpoch);
  });

  it('should handle Date.now() correctly (already in ms)', () => {
    const now = Date.now();
    expect(ensureEpochMs(now)).toBe(now);
  });

  it('should handle recent dates in seconds', () => {
    // 2024-01-01 in seconds
    const seconds = 1704067200;
    const expected = 1704067200000;
    expect(ensureEpochMs(seconds)).toBe(expected);
  });

  it('should handle recent dates in milliseconds', () => {
    // 2024-01-01 in milliseconds
    const ms = 1704067200000;
    expect(ensureEpochMs(ms)).toBe(ms);
  });

  it('should handle edge case: exactly 1e12 (already ms)', () => {
    // 1e12 ms = Sep 2001
    expect(ensureEpochMs(1e12)).toBe(1e12);
  });

  it('should handle edge case: just below 1e12 (seconds)', () => {
    // Just below 1e12, treat as seconds
    const seconds = 999999999999;
    expect(ensureEpochMs(seconds)).toBe(seconds * 1000);
  });
});
