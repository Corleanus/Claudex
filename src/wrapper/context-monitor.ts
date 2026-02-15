/**
 * Claudex v2 — Context Window Monitor
 *
 * Pure functions for assessing context window utilization.
 * The monitor DETECTS — it doesn't ACT. No side effects.
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('context-monitor');

export interface ContextUtilization {
  currentTokens: number;
  maxTokens: number;
  utilization: number;        // 0.0 to 1.0
  level: 'normal' | 'warn' | 'flush';
}

/**
 * Validate and normalize threshold config.
 * - Clamps both thresholds to [0.0, 1.0]
 * - If warnThreshold >= flushThreshold, resets both to defaults (0.70, 0.80)
 */
export function validateThresholds(
  config: { warnThreshold: number; flushThreshold: number },
): { warnThreshold: number; flushThreshold: number } {
  let warn = config.warnThreshold;
  let flush = config.flushThreshold;

  // Guard against NaN/Infinity — replace with defaults
  if (!Number.isFinite(warn)) {
    log.warn(`Invalid warnThreshold (${warn}), using default 0.70`);
    warn = 0.70;
  }
  if (!Number.isFinite(flush)) {
    log.warn(`Invalid flushThreshold (${flush}), using default 0.80`);
    flush = 0.80;
  }

  // Clamp to [0.0, 1.0]
  warn = Math.max(0, Math.min(1, warn));
  flush = Math.max(0, Math.min(1, flush));

  // warnThreshold must be strictly less than flushThreshold
  if (warn >= flush) {
    warn = 0.70;
    flush = 0.80;
  }

  return { warnThreshold: warn, flushThreshold: flush };
}

/**
 * Assess context window utilization against configured thresholds.
 *
 * @param currentTokens - Current token count in the context window
 * @param maxTokens - Maximum token capacity of the context window
 * @param config - Threshold configuration (validated internally)
 * @returns ContextUtilization with computed level
 */
export function assessUtilization(
  currentTokens: number,
  maxTokens: number,
  config: { warnThreshold: number; flushThreshold: number },
): ContextUtilization {
  // Guard: prevent division by zero and invalid inputs
  if (maxTokens <= 0) {
    return { currentTokens, maxTokens, utilization: 0, level: 'normal' };
  }
  if (currentTokens < 0) {
    return { currentTokens: 0, maxTokens, utilization: 0, level: 'normal' };
  }

  const validated = validateThresholds(config);
  const utilization = Math.min(currentTokens / maxTokens, 1.0);

  let level: ContextUtilization['level'] = 'normal';
  if (utilization >= validated.flushThreshold) {
    level = 'flush';
  } else if (utilization >= validated.warnThreshold) {
    level = 'warn';
  }

  return { currentTokens, maxTokens, utilization, level };
}

/**
 * Check if the context window is at or above the flush threshold.
 */
export function shouldFlush(utilization: ContextUtilization): boolean {
  return utilization.level === 'flush';
}

/**
 * Check if the context window is at or above the warn threshold.
 */
export function shouldWarn(utilization: ContextUtilization): boolean {
  return utilization.level === 'warn' || utilization.level === 'flush';
}
