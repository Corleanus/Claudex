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
  validateThresholds,
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

describe('validateThresholds', () => {
  it('passes through valid thresholds', () => {
    const result = validateThresholds({ warnThreshold: 0.60, flushThreshold: 0.85 });
    expect(result.warnThreshold).toBeCloseTo(0.60);
    expect(result.flushThreshold).toBeCloseTo(0.85);
  });

  it('clamps thresholds below 0 to 0', () => {
    const result = validateThresholds({ warnThreshold: -0.5, flushThreshold: 0.80 });
    expect(result.warnThreshold).toBe(0);
    expect(result.flushThreshold).toBeCloseTo(0.80);
  });

  it('clamps thresholds above 1 to 1', () => {
    const result = validateThresholds({ warnThreshold: 0.70, flushThreshold: 1.5 });
    expect(result.warnThreshold).toBeCloseTo(0.70);
    expect(result.flushThreshold).toBe(1);
  });

  it('resets to defaults when warnThreshold >= flushThreshold', () => {
    const result = validateThresholds({ warnThreshold: 0.90, flushThreshold: 0.80 });
    expect(result.warnThreshold).toBeCloseTo(0.70);
    expect(result.flushThreshold).toBeCloseTo(0.80);
  });

  it('resets to defaults when thresholds are equal', () => {
    const result = validateThresholds({ warnThreshold: 0.80, flushThreshold: 0.80 });
    expect(result.warnThreshold).toBeCloseTo(0.70);
    expect(result.flushThreshold).toBeCloseTo(0.80);
  });

  it('handles both thresholds out of range with warn >= flush after clamping', () => {
    // Both clamp to 1.0, then 1.0 >= 1.0 triggers reset to defaults
    const result = validateThresholds({ warnThreshold: 2.0, flushThreshold: 1.5 });
    expect(result.warnThreshold).toBeCloseTo(0.70);
    expect(result.flushThreshold).toBeCloseTo(0.80);
  });

  it('replaces NaN thresholds with defaults', () => {
    const result = validateThresholds({ warnThreshold: NaN, flushThreshold: NaN });
    expect(result.warnThreshold).toBe(0.70);
    expect(result.flushThreshold).toBe(0.80);
  });

  it('replaces Infinity thresholds with defaults', () => {
    const result = validateThresholds({ warnThreshold: Infinity, flushThreshold: -Infinity });
    expect(result.warnThreshold).toBe(0.70);
    expect(result.flushThreshold).toBe(0.80);
  });

  it('replaces only the non-finite threshold, keeps the valid one', () => {
    const result = validateThresholds({ warnThreshold: NaN, flushThreshold: 0.90 });
    expect(result.warnThreshold).toBe(0.70);
    expect(result.flushThreshold).toBeCloseTo(0.90);
  });
});

describe('assessUtilization with invalid thresholds', () => {
  it('uses defaults when warn >= flush', () => {
    // Inverted thresholds: should reset to 0.70/0.80
    // At 75% utilization, should be "warn" with default thresholds
    const result = assessUtilization(7500, 10000, { warnThreshold: 0.90, flushThreshold: 0.80 });
    expect(result.level).toBe('warn');
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
