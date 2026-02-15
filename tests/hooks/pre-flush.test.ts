import { describe, it, expect, afterEach, vi } from 'vitest';
import { assessUtilization, shouldFlush, shouldWarn } from '../../src/wrapper/context-monitor.js';
import { isCooldownActive, resetCooldown, executeFlush } from '../../src/wrapper/flush-trigger.js';

// Mock logger to prevent filesystem writes during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_THRESHOLDS = { warnThreshold: 0.70, flushThreshold: 0.80 };
const CUSTOM_THRESHOLDS = { warnThreshold: 0.50, flushThreshold: 0.60 };

// =============================================================================
// Tests
// =============================================================================

describe('Pre-flush hook logic integration', () => {
  afterEach(() => {
    resetCooldown();
  });

  describe('assessUtilization + shouldFlush/shouldWarn at normal level', () => {
    it('60% utilization returns level normal, shouldFlush false, shouldWarn false', () => {
      const result = assessUtilization(6000, 10000, DEFAULT_THRESHOLDS);

      expect(result.level).toBe('normal');
      expect(result.utilization).toBeCloseTo(0.6, 5);
      expect(result.currentTokens).toBe(6000);
      expect(result.maxTokens).toBe(10000);
      expect(shouldFlush(result)).toBe(false);
      expect(shouldWarn(result)).toBe(false);
    });
  });

  describe('assessUtilization + shouldFlush/shouldWarn at warn level', () => {
    it('75% utilization returns level warn, shouldFlush false, shouldWarn true', () => {
      const result = assessUtilization(7500, 10000, DEFAULT_THRESHOLDS);

      expect(result.level).toBe('warn');
      expect(result.utilization).toBeCloseTo(0.75, 5);
      expect(shouldFlush(result)).toBe(false);
      expect(shouldWarn(result)).toBe(true);
    });
  });

  describe('assessUtilization + shouldFlush/shouldWarn at flush level', () => {
    it('85% utilization returns level flush, shouldFlush true', () => {
      const result = assessUtilization(8500, 10000, DEFAULT_THRESHOLDS);

      expect(result.level).toBe('flush');
      expect(result.utilization).toBeCloseTo(0.85, 5);
      expect(shouldFlush(result)).toBe(true);
      expect(shouldWarn(result)).toBe(true);
    });
  });

  describe('cooldown prevents re-flush', () => {
    it('isCooldownActive returns true after executeFlush, then false after resetCooldown', async () => {
      // Before any flush, cooldown should not be active (lastFlushEpoch is 0)
      expect(isCooldownActive(30000)).toBe(false);

      // Execute a minimal flush to set lastFlushEpoch
      // We need a mock DB for this — use a minimal in-memory one
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');

      await executeFlush({
        db,
        sessionId: 'test-session',
        scope: { type: 'global', name: 'global', root: '/' },
        hologramRescore: false,
      });

      // Now cooldown should be active (within 30s of flush)
      expect(isCooldownActive(30000)).toBe(true);

      // Reset cooldown
      resetCooldown();
      expect(isCooldownActive(30000)).toBe(false);

      db.close();
    });
  });

  describe('custom thresholds', () => {
    it('50% warn / 60% flush thresholds work correctly at 55%', () => {
      const result = assessUtilization(5500, 10000, CUSTOM_THRESHOLDS);

      expect(result.level).toBe('warn');
      expect(result.utilization).toBeCloseTo(0.55, 5);
      expect(shouldFlush(result)).toBe(false);
      expect(shouldWarn(result)).toBe(true);
    });

    it('50% warn / 60% flush thresholds classify 65% as flush', () => {
      const result = assessUtilization(6500, 10000, CUSTOM_THRESHOLDS);

      expect(result.level).toBe('flush');
      expect(result.utilization).toBeCloseTo(0.65, 5);
      expect(shouldFlush(result)).toBe(true);
    });

    it('50% warn / 60% flush thresholds classify 45% as normal', () => {
      const result = assessUtilization(4500, 10000, CUSTOM_THRESHOLDS);

      expect(result.level).toBe('normal');
      expect(shouldFlush(result)).toBe(false);
      expect(shouldWarn(result)).toBe(false);
    });
  });

  describe('maxTokens 0 edge case', () => {
    it('assessUtilization returns normal when maxTokens is 0', () => {
      const result = assessUtilization(5000, 0, DEFAULT_THRESHOLDS);

      expect(result.level).toBe('normal');
      expect(result.utilization).toBe(0);
      expect(shouldFlush(result)).toBe(false);
      expect(shouldWarn(result)).toBe(false);
    });

    it('assessUtilization returns normal when maxTokens is negative', () => {
      const result = assessUtilization(5000, -1, DEFAULT_THRESHOLDS);

      expect(result.level).toBe('normal');
      expect(result.utilization).toBe(0);
      expect(shouldFlush(result)).toBe(false);
    });
  });
});
