/**
 * Claudex v2 — Context Window Monitor
 *
 * Pure functions for assessing context window utilization.
 * The monitor DETECTS — it doesn't ACT. No side effects.
 */

export interface ContextUtilization {
  currentTokens: number;
  maxTokens: number;
  utilization: number;        // 0.0 to 1.0
  level: 'normal' | 'warn' | 'flush';
}

/**
 * Assess context window utilization against configured thresholds.
 *
 * @param currentTokens - Current token count in the context window
 * @param maxTokens - Maximum token capacity of the context window
 * @param config - Threshold configuration
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

  const utilization = Math.min(currentTokens / maxTokens, 1.0);

  let level: ContextUtilization['level'] = 'normal';
  if (utilization >= config.flushThreshold) {
    level = 'flush';
  } else if (utilization >= config.warnThreshold) {
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
