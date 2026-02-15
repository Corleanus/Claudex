/**
 * Claudex v2 — Hologram Degradation Handlers (WP-08)
 *
 * Wraps HologramClient with fallback behavior when the sidecar is
 * unavailable, slow, or erroring. Falls back to recency-based file
 * listing so the system never crashes due to sidecar issues.
 */

import type Database from 'better-sqlite3';
import type { ClaudexConfig, HologramResponse, ScoredFile } from '../shared/types.js';
import type { HologramClient } from './client.js';
import { getHotFiles, getWarmFiles } from '../db/pressure.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('hologram-degradation');

// =============================================================================
// Types
// =============================================================================

export interface ContextSuggestion extends HologramResponse {
  source: 'hologram' | 'db-pressure' | 'recency-fallback';
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
   * Degradation chain: Hologram → DB Pressure Scores → Recency fallback.
   *
   * On first failure, retries once (sidecar may have just restarted).
   * On second failure, tries DB pressure scores if db is provided.
   * If DB has no scores (or db not provided), falls back to recency.
   * Never throws.
   *
   * @param db - Optional database handle. When provided, enables DB pressure fallback tier.
   * @param project - Optional project name for scoping DB queries.
   */
  async queryWithFallback(
    prompt: string,
    turnNumber: number,
    sessionId: string,
    recentFiles: string[],
    db?: Database.Database,
    project?: string,
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
        `Hologram sidecar unavailable after retry (timeout: ${this.timeoutMs}ms)`,
        retryError,
      );
    }

    // DB pressure fallback — try persisted scores before recency
    if (db) {
      const dbFallback = this.dbPressureFallback(db, project);
      if (dbFallback !== null) {
        log.info('Using DB pressure scores as fallback');
        return dbFallback;
      }
    }

    log.info('Falling back to recency-based context');
    return this.recencyFallback(recentFiles);
  }

  /**
   * Build a fallback suggestion from persisted DB pressure scores.
   * Returns null if no scores are available, so the caller can fall through to recency.
   */
  private dbPressureFallback(db: Database.Database, project?: string): ContextSuggestion | null {
    try {
      const hotScores = getHotFiles(db, project);
      const warmScores = getWarmFiles(db, project);

      if (hotScores.length === 0 && warmScores.length === 0) {
        log.debug('No DB pressure scores available for fallback');
        return null;
      }

      const toScoredFile = (score: { file_path: string; raw_pressure: number; temperature: string }): ScoredFile => ({
        path: score.file_path,
        raw_pressure: score.raw_pressure,
        temperature: score.temperature as 'HOT' | 'WARM' | 'COLD',
        system_bucket: 0,
        pressure_bucket: Math.round(score.raw_pressure * 47),
      });

      return {
        source: 'db-pressure',
        hot: hotScores.map(toScoredFile),
        warm: warmScores.map(toScoredFile),
        cold: [],
      };
    } catch (err) {
      log.error('Failed to load DB pressure scores for fallback', err);
      return null;
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
