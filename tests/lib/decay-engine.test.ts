import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeEI, getHalfLife, isImmune } from '../../src/lib/decay-engine.js';

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
// getHalfLife
// =============================================================================

describe('getHalfLife', () => {
  it('importance 1 → 3 days', () => {
    expect(getHalfLife(1)).toBe(3);
  });

  it('importance 2 → 7 days', () => {
    expect(getHalfLife(2)).toBe(7);
  });

  it('importance 3 → 30 days', () => {
    expect(getHalfLife(3)).toBe(30);
  });

  it('importance 4 → 90 days', () => {
    expect(getHalfLife(4)).toBe(90);
  });

  it('importance 5 → 365 days', () => {
    expect(getHalfLife(5)).toBe(365);
  });

  it('clamps below 1 to 3 days', () => {
    expect(getHalfLife(0)).toBe(3);
  });

  it('clamps above 5 to 365 days', () => {
    expect(getHalfLife(6)).toBe(365);
  });
});

// =============================================================================
// computeEI
// =============================================================================

describe('computeEI', () => {
  it('critical importance produces highest score (vs low importance)', () => {
    const critical = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const low = computeEI({ importance: 1, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    expect(critical).toBeGreaterThan(low);
  });

  it('low importance produces lowest score (vs critical)', () => {
    const low = computeEI({ importance: 1, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const critical = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    expect(low).toBeLessThan(critical);
  });

  it('access boost: accessCount=5 scores higher than accessCount=0', () => {
    const base = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const boosted = computeEI({ importance: 3, accessCount: 5, daysSinceAccess: 0, coOccurrences: 0 });
    expect(boosted).toBeGreaterThan(base);
  });

  it('decay over time: 30 days scores lower than 0 days', () => {
    const fresh = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const aged = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 30, coOccurrences: 0 });
    expect(aged).toBeLessThan(fresh);
  });

  it('connectivity bonus: coOccurrences=5 scores higher than coOccurrences=0', () => {
    const base = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    const connected = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 5 });
    expect(connected).toBeGreaterThan(base);
  });

  it('coOccurrences capped at 5 (coOccurrences=10 equals coOccurrences=5)', () => {
    const at5 = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 5 });
    const at10 = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 0, coOccurrences: 10 });
    expect(at5).toBeCloseTo(at10, 10);
  });

  it('all factors combined — critical + high access + fresh + well-connected', () => {
    const score = computeEI({ importance: 5, accessCount: 10, daysSinceAccess: 0, coOccurrences: 5 });
    // baseWeight=1.0, accessFactor=ln(11)≈2.398, decayFactor=1.0, connectivityBonus=1.5
    expect(score).toBeGreaterThan(1.0);
    expect(score).toBeGreaterThan(2.0);
  });

  it('importance 5 fresh has EI = 1.0 × max(1,ln(1)) × 1.0 × 1.0 = 1.0', () => {
    const score = computeEI({ importance: 5, accessCount: 0, daysSinceAccess: 0, coOccurrences: 0 });
    // baseWeight=1.0, accessFactor=max(1,ln(1))=max(1,0)=1, decayFactor=1, connectivity=1
    expect(score).toBeCloseTo(1.0, 5);
  });

  it('at half-life: decayFactor = 0.5 for importance 3 at 30 days, no access boost', () => {
    const score = computeEI({ importance: 3, accessCount: 0, daysSinceAccess: 30, coOccurrences: 0 });
    // baseWeight=0.6, accessFactor=1, decayFactor=0.5, connectivity=1
    expect(score).toBeCloseTo(0.3, 5);
  });
});

// =============================================================================
// isImmune
// =============================================================================

describe('isImmune', () => {
  const NINETY_DAYS_MS = 90 * 86400 * 1000;

  it('critical importance (5) is always immune', () => {
    expect(isImmune(5, 0, null)).toBe(true);
  });

  it('importance > 5 is immune (clamped critical)', () => {
    expect(isImmune(6, 0, null)).toBe(true);
  });

  it('accessCount >= 3 with recent access is immune', () => {
    const recentEpoch = Date.now() - 10 * 86400 * 1000; // 10 days ago
    expect(isImmune(3, 3, recentEpoch)).toBe(true);
  });

  it('accessCount >= 3 with stale access (> 90 days) is NOT immune', () => {
    const staleEpoch = Date.now() - 100 * 86400 * 1000; // 100 days ago
    expect(isImmune(3, 3, staleEpoch)).toBe(false);
  });

  it('accessCount >= 3 with null last access is NOT immune', () => {
    expect(isImmune(3, 3, null)).toBe(false);
  });

  it('low importance + low access is not immune', () => {
    expect(isImmune(1, 0, null)).toBe(false);
  });

  it('accessCount < 3 with recent access is not immune', () => {
    const recentEpoch = Date.now() - 5 * 86400 * 1000;
    expect(isImmune(2, 2, recentEpoch)).toBe(false);
  });

  it('boundary: exactly 90 days ago is NOT immune (must be strictly less than 90d)', () => {
    const exactlyNinetyDaysAgo = Date.now() - NINETY_DAYS_MS;
    // Date.now() - epoch = NINETY_DAYS_MS which is NOT < NINETY_DAYS_MS
    expect(isImmune(3, 3, exactlyNinetyDaysAgo)).toBe(false);
  });
});
