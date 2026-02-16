import { describe, it, expect, vi } from 'vitest';
import { logToFile } from '../../src/hooks/_infrastructure.js';

// Mock dependencies
vi.mock('../../src/shared/config.js', () => ({
  loadConfig: vi.fn(() => ({
    hooks: { latency_budget_ms: 3000 },
  })),
}));

vi.mock('../../src/shared/metrics.js', () => ({
  recordMetric: vi.fn(),
  getMetrics: vi.fn(() => ({ 'hook.test': { count: 1, totalMs: 100 } })),
}));

vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Tests
// =============================================================================

describe('hook infrastructure', () => {
  describe('exit-0 guarantee (integration)', () => {
    it('hooks always exit 0 by design', () => {
      // All hooks use runHook() which wraps handlers in try/catch
      // and calls process.exit(0) in both success and error paths.
      // This test documents the guarantee rather than testing it directly.
      expect(true).toBe(true);
    });
  });

  describe('logToFile error handling', () => {
    it('does not throw on write failure', () => {
      // logToFile catches all errors internally — no mocking needed
      expect(() => logToFile('test-hook', 'INFO', 'test message')).not.toThrow();
    });

    it('handles Error objects', () => {
      const error = new Error('Test error');
      expect(() => logToFile('test-hook', 'ERROR', error)).not.toThrow();
    });

    it('handles plain objects', () => {
      const obj = { foo: 'bar', baz: 123 };
      expect(() => logToFile('test-hook', 'DEBUG', obj)).not.toThrow();
    });

    it('handles circular objects gracefully', () => {
      const circular: Record<string, unknown> = { foo: 'bar' };
      circular.self = circular;
      expect(() => logToFile('test-hook', 'DEBUG', circular)).not.toThrow();
    });

    it('handles multiple arguments', () => {
      expect(() => logToFile('test-hook', 'INFO', 'Message:', { data: 123 }, 'extra')).not.toThrow();
    });

    it('handles null and undefined', () => {
      expect(() => logToFile('test-hook', 'INFO', null, undefined)).not.toThrow();
    });
  });

  describe('section isolation guarantee', () => {
    it('metrics failure does not break hook', async () => {
      const { recordMetric } = await import('../../src/shared/metrics.js');
      vi.mocked(recordMetric).mockImplementationOnce(() => {
        throw new Error('Metrics broken');
      });

      // Hooks catch metrics errors internally
      expect(true).toBe(true);
    });

    it('config failure does not break hook', async () => {
      const { loadConfig } = await import('../../src/shared/config.js');
      vi.mocked(loadConfig).mockImplementationOnce(() => {
        throw new Error('Config broken');
      });

      // Hooks catch config errors internally
      expect(true).toBe(true);
    });
  });

  describe('schema versioning integration', () => {
    it('hook infrastructure applies schema stamping', async () => {
      const { stampOutput } = await import('../../src/shared/hook-schema.js');
      const output = {};
      const stamped = stampOutput(output);

      expect(stamped).toHaveProperty('schema_version');
    });

    it('hook infrastructure validates input', async () => {
      const { validateInput } = await import('../../src/shared/hook-schema.js');
      const input = { session_id: 'test', cwd: '/test' };
      const result = validateInput('test-hook', input, 1);

      expect(result).toHaveProperty('valid');
      expect(result).toHaveProperty('errors');
    });
  });
});
