/**
 * Claudex v2 — Metrics Collector
 *
 * Lightweight in-memory metrics for hooks, DB operations, hologram queries,
 * flush cycles, and degradation fallbacks. Never throws. No persistence.
 */

// =============================================================================
// Types
// =============================================================================

export interface MetricEntry {
  name: string;
  count: number;
  totalMs: number;
  lastMs: number;
  errors: number;
}

// =============================================================================
// Internal Store
// =============================================================================

let store: Record<string, MetricEntry> = {};

// =============================================================================
// Public API
// =============================================================================

/**
 * Record a metric data point. Creates the entry if it doesn't exist.
 * Increments count, accumulates totalMs, updates lastMs, and optionally
 * increments the error counter.
 */
export function recordMetric(name: string, durationMs: number, error?: boolean): void {
  try {
    let entry = store[name];
    if (!entry) {
      entry = { name, count: 0, totalMs: 0, lastMs: 0, errors: 0 };
      store[name] = entry;
    }

    entry.count += 1;
    entry.totalMs += durationMs;
    entry.lastMs = durationMs;

    if (error) {
      entry.errors += 1;
    }
  } catch {
    // Metrics must never throw. Swallow silently.
  }
}

/**
 * Return a deep copy of all collected metrics.
 * Callers get a fully detached snapshot — mutations won't affect the store.
 */
export function getMetrics(): Record<string, MetricEntry> {
  try {
    return Object.fromEntries(
      Object.entries(store).map(([k, v]) => [k, { ...v }])
    );
  } catch {
    return {};
  }
}

/**
 * Clear all collected metrics.
 */
export function resetMetrics(): void {
  try {
    store = {};
  } catch {
    // Swallow silently.
  }
}
