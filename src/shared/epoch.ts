/**
 * Claudex v2 — Epoch Millisecond Utilities
 *
 * Convention: timestamp_epoch is ALWAYS milliseconds throughout the codebase.
 * This module ensures external inputs conform to that standard.
 */

/**
 * Ensure a timestamp is in milliseconds.
 * If the value appears to be in seconds (< 1e12), convert to milliseconds.
 * Otherwise, return as-is.
 *
 * Examples:
 * - ensureEpochMs(1609459200) → 1609459200000 (seconds → ms)
 * - ensureEpochMs(1609459200000) → 1609459200000 (already ms)
 * - ensureEpochMs(Date.now()) → Date.now() (already ms)
 */
export function ensureEpochMs(value: number): number {
  // If value is less than 1e12 (Jan 2001 in ms, Sep 2001 in seconds),
  // it's likely in seconds — convert to ms.
  // 1e12 ms = Sep 2001, 1e12 seconds = far future (year 33658).
  // Any reasonable timestamp in seconds will be < 1e12.
  // Any reasonable timestamp in ms will be >= 1e12.
  if (value < 1e12) {
    return value * 1000;
  }
  return value;
}
