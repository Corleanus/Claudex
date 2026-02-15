/**
 * Claudex v2 — Hologram Degradation Handlers (WP-08)
 *
 * Wraps HologramClient with fallback behavior when the sidecar is
 * unavailable, slow, or erroring. Falls back to recency-based file
 * listing so the system never crashes due to sidecar issues.
 */

import type { ClaudexConfig, HologramResponse } from '../shared/types.js';
import type { HologramClient } from './client.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hologram-degradation');

// =============================================================================
// Types
// =============================================================================

export interface ContextSuggestion extends HologramResponse {
  source: 'hologram' | 'recency-fallback';
}

// =============================================================================
// ResilientHologramClient
// =============================================================================

export class ResilientHologramClient {
  private readonly timeoutMs: number;

  constructor(
    private client: HologramClient,
    config: ClaudexConfig,
  ) {
    this.timeoutMs = config.hologram?.timeout_ms ?? 2000;
  }

  /**
   * Query hologram with one retry then automatic fallback.
   *
   * On first failure, retries once (sidecar may have just restarted).
   * On second failure, logs degradation and returns recency fallback.
   * Never throws.
   */
  async queryWithFallback(
    prompt: string,
    turnNumber: number,
    sessionId: string,
    recentFiles: string[],
  ): Promise<ContextSuggestion> {
    // First attempt
    try {
      const response = await this.client.query(prompt, turnNumber, sessionId);
      return { source: 'hologram', ...response };
    } catch (firstError) {
      log.warn('Hologram query failed, retrying once', firstError);
    }

    // Single retry — sidecar may have just recovered
    try {
      const response = await this.client.query(prompt, turnNumber, sessionId);
      return { source: 'hologram', ...response };
    } catch (retryError) {
      log.error(
        `Hologram sidecar unavailable after retry (timeout: ${this.timeoutMs}ms), falling back to recency`,
        retryError,
      );
      return this.recencyFallback(recentFiles);
    }
  }

  /**
   * Build a recency-based fallback suggestion from recently-touched files.
   * All files are classified as WARM with a neutral pressure score.
   */
  private recencyFallback(recentFiles: string[]): ContextSuggestion {
    return {
      source: 'recency-fallback',
      hot: [],
      warm: recentFiles.map(f => ({
        path: f,
        raw_pressure: 0.5,
        temperature: 'WARM' as const,
        system_bucket: 0,
        pressure_bucket: 24,
      })),
      cold: [],
    };
  }
}
