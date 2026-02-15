/**
 * Claudex v2 — Tests: Context Monitor
 *
 * Tests the pure functions in src/wrapper/context-monitor.ts:
 * assessUtilization, shouldFlush, shouldWarn.
 */

import { describe, it, expect } from 'vitest';
import {
  assessUtilization,
  shouldFlush,
  shouldWarn,
  type ContextUtilization,
} from '../../src/wrapper/context-monitor.js';

const DEFAULT_CONFIG = { warnThreshold: 0.70, flushThreshold: 0.80 };

describe('assessUtilization', () => {
  it('returns "normal" below warnThreshold', () => {
    const result = assessUtilization(5000, 10000, DEFAULT_CONFIG);
    expect(result.level).toBe('normal');
    expect(result.utilization).toBeCloseTo(0.5);
    expect(result.currentTokens).toBe(5000);
    expect(result.maxTokens).toBe(10000);
  });

  it('returns "warn" at/above warnThreshold but below flushThreshold', () => {
    const result = assessUtilization(7500, 10000, DEFAULT_CONFIG);
    expect(result.level).toBe('warn');
    expect(result.utilization).toBeCloseTo(0.75);
  });

  it('returns "flush" at/above flushThreshold', () => {
    const result = assessUtilization(9000, 10000, DEFAULT_CONFIG);
    expect(result.level).toBe('flush');
    expect(result.utilization).toBeCloseTo(0.9);
  });

  it('handles maxTokens <= 0 (returns normal with utilization 0)', () => {
    const resultZero = assessUtilization(5000, 0, DEFAULT_CONFIG);
    expect(resultZero.level).toBe('normal');
    expect(resultZero.utilization).toBe(0);

    const resultNeg = assessUtilization(5000, -100, DEFAULT_CONFIG);
    expect(resultNeg.level).toBe('normal');
    expect(resultNeg.utilization).toBe(0);
  });

  it('handles negative currentTokens', () => {
    const result = assessUtilization(-500, 10000, DEFAULT_CONFIG);
    expect(result.level).toBe('normal');
    expect(result.utilization).toBe(0);
    // Implementation normalizes currentTokens to 0
    expect(result.currentTokens).toBe(0);
  });

  it('caps utilization at 1.0 when currentTokens > maxTokens', () => {
    const result = assessUtilization(15000, 10000, DEFAULT_CONFIG);
    expect(result.utilization).toBe(1.0);
    expect(result.level).toBe('flush');
  });

  it('returns "warn" at exact boundary of warnThreshold (0.70)', () => {
    const result = assessUtilization(7000, 10000, DEFAULT_CONFIG);
    expect(result.utilization).toBeCloseTo(0.70);
    expect(result.level).toBe('warn');
  });

  it('returns "flush" at exact boundary of flushThreshold (0.80)', () => {
    const result = assessUtilization(8000, 10000, DEFAULT_CONFIG);
    expect(result.utilization).toBeCloseTo(0.80);
    expect(result.level).toBe('flush');
  });

  it('returns "normal" just below warnThreshold (0.699...)', () => {
    // 6999 / 10000 = 0.6999
    const result = assessUtilization(6999, 10000, DEFAULT_CONFIG);
    expect(result.utilization).toBeLessThan(0.70);
    expect(result.level).toBe('normal');
  });
});

describe('shouldFlush', () => {
  it('returns true only for "flush" level', () => {
    const flush: ContextUtilization = {
      currentTokens: 9000,
      maxTokens: 10000,
      utilization: 0.9,
      level: 'flush',
    };
    expect(shouldFlush(flush)).toBe(true);
  });

  it('returns false for "warn"', () => {
    const warn: ContextUtilization = {
      currentTokens: 7500,
      maxTokens: 10000,
      utilization: 0.75,
      level: 'warn',
    };
    expect(shouldFlush(warn)).toBe(false);
  });

  it('returns false for "normal"', () => {
    const normal: ContextUtilization = {
      currentTokens: 5000,
      maxTokens: 10000,
      utilization: 0.5,
      level: 'normal',
    };
    expect(shouldFlush(normal)).toBe(false);
  });
});

describe('shouldWarn', () => {
  it('returns true for "warn" level', () => {
    const warn: ContextUtilization = {
      currentTokens: 7500,
      maxTokens: 10000,
      utilization: 0.75,
      level: 'warn',
    };
    expect(shouldWarn(warn)).toBe(true);
  });

  it('returns true for "flush" level', () => {
    const flush: ContextUtilization = {
      currentTokens: 9000,
      maxTokens: 10000,
      utilization: 0.9,
      level: 'flush',
    };
    expect(shouldWarn(flush)).toBe(true);
  });

  it('returns false for "normal" level', () => {
    const normal: ContextUtilization = {
      currentTokens: 5000,
      maxTokens: 10000,
      utilization: 0.5,
      level: 'normal',
    };
    expect(shouldWarn(normal)).toBe(false);
  });
});
