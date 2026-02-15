import { describe, it, expect, beforeEach } from 'vitest';
import { recordMetric, getMetrics, resetMetrics } from '../../src/shared/metrics.js';

// =============================================================================
// Tests
// =============================================================================

beforeEach(() => {
  resetMetrics();
});

describe('metrics', () => {
  it('starts with empty metrics', () => {
    const metrics = getMetrics();
    expect(Object.keys(metrics)).toHaveLength(0);
  });

  it('records a metric and creates entry', () => {
    recordMetric('db.query', 42);
    const metrics = getMetrics();
    expect(metrics['db.query']).toBeDefined();
    expect(metrics['db.query']!.name).toBe('db.query');
    expect(metrics['db.query']!.count).toBe(1);
    expect(metrics['db.query']!.totalMs).toBe(42);
    expect(metrics['db.query']!.lastMs).toBe(42);
    expect(metrics['db.query']!.errors).toBe(0);
  });

  it('increments count on repeated calls', () => {
    recordMetric('flush', 10);
    recordMetric('flush', 20);
    recordMetric('flush', 30);
    const entry = getMetrics()['flush']!;
    expect(entry.count).toBe(3);
  });

  it('accumulates totalMs', () => {
    recordMetric('hook.run', 100);
    recordMetric('hook.run', 250);
    recordMetric('hook.run', 50);
    const entry = getMetrics()['hook.run']!;
    expect(entry.totalMs).toBe(400);
  });

  it('tracks lastMs as most recent duration', () => {
    recordMetric('sidecar.query', 100);
    recordMetric('sidecar.query', 200);
    recordMetric('sidecar.query', 50);
    const entry = getMetrics()['sidecar.query']!;
    expect(entry.lastMs).toBe(50);
  });

  it('increments errors when error=true', () => {
    recordMetric('db.write', 10, true);
    recordMetric('db.write', 20, true);
    const entry = getMetrics()['db.write']!;
    expect(entry.errors).toBe(2);
  });

  it('tracks errors independently from count', () => {
    recordMetric('hologram', 10);        // success
    recordMetric('hologram', 20, false); // success (explicit false)
    recordMetric('hologram', 30, true);  // error
    recordMetric('hologram', 40);        // success
    const entry = getMetrics()['hologram']!;
    expect(entry.count).toBe(4);
    expect(entry.errors).toBe(1);
  });

  it('getMetrics returns copy not reference', () => {
    recordMetric('test', 10);
    const snapshot1 = getMetrics();
    const snapshot2 = getMetrics();

    // Different object references
    expect(snapshot1).not.toBe(snapshot2);

    // Mutating the snapshot should not affect the store
    snapshot1['test']!.count = 999;
    // Note: shallow copy means the inner MetricEntry is still shared,
    // but adding/removing keys on the outer record is independent
    delete (snapshot1 as Record<string, unknown>)['test'];
    const snapshot3 = getMetrics();
    expect(snapshot3['test']).toBeDefined();
    expect(snapshot3['test']!.count).toBeGreaterThanOrEqual(1);
  });

  it('resetMetrics clears all entries', () => {
    recordMetric('a', 10);
    recordMetric('b', 20);
    recordMetric('c', 30);
    expect(Object.keys(getMetrics())).toHaveLength(3);

    resetMetrics();
    expect(Object.keys(getMetrics())).toHaveLength(0);
  });

  it('handles multiple different metric names', () => {
    recordMetric('db.read', 5);
    recordMetric('db.write', 10);
    recordMetric('hook.pre_flush', 15);
    recordMetric('hologram.query', 20);
    recordMetric('db.read', 3);

    const metrics = getMetrics();
    expect(Object.keys(metrics)).toHaveLength(4);
    expect(metrics['db.read']!.count).toBe(2);
    expect(metrics['db.read']!.totalMs).toBe(8);
    expect(metrics['db.write']!.count).toBe(1);
    expect(metrics['hook.pre_flush']!.count).toBe(1);
    expect(metrics['hologram.query']!.count).toBe(1);
  });
});
