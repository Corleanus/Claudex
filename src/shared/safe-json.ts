/**
 * Claudex v2 — Safe JSON parsing utility
 *
 * Ensures one malformed JSON value doesn't crash an entire query.
 * Used by all DB functions that parse JSON from row fields.
 */

import { createLogger } from './logger.js';

const log = createLogger('safe-json');

/**
 * Parse JSON safely. Returns fallback on parse error instead of throwing.
 * Logs a warning on failure to aid debugging.
 */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log.warn(`Failed to parse JSON, using fallback. Raw: ${raw.slice(0, 100)}`, err);
    return fallback;
  }
}
