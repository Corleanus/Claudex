/**
 * Claudex v2 — Decay & Selection Pressure Engine
 *
 * Implements stratified half-lives, EI (Effective Importance) formula,
 * and soft-delete pruning for observations.
 *
 * EI formula (mnemon-derived):
 *   baseWeight × accessFactor × decayFactor × connectivityBonus
 *
 * Half-lives from Kore stratified model:
 *   importance 5 → 365d, 4 → 90d, 3 → 30d, 2 → 7d, 1 → 3d
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';

const log = createLogger('decay-engine');

// =============================================================================
// Half-Life Table
// =============================================================================

const HALF_LIFE_DAYS: Record<number, number> = {
  5: 365,
  4: 90,
  3: 30,
  2: 7,
  1: 3,
};

/**
 * Maps observation importance (1-5) to base half-life in days.
 * Clamps to known range: < 1 → 3d, > 5 → 365d.
 */
export function getHalfLife(importance: number): number {
  const clamped = Math.max(1, Math.min(5, Math.round(importance)));
  return HALF_LIFE_DAYS[clamped] ?? 3;
}

// =============================================================================
// EI Computation
// =============================================================================

export interface EIParams {
  importance: number;
  accessCount: number;
  daysSinceAccess: number;
  coOccurrences: number;
}

/**
 * Compute Effective Importance (EI) for an observation.
 *
 * Formula:
 *   baseWeight = importance / 5
 *   accessFactor = max(1, ln(1 + accessCount))
 *   effectiveHalfLife = getHalfLife(importance) × (1 + 0.15 × accessCount)
 *   decayFactor = 0.5 ^ (daysSinceAccess / effectiveHalfLife)
 *   connectivityBonus = 1 + 0.1 × min(coOccurrences, 5)
 *   EI = baseWeight × accessFactor × decayFactor × connectivityBonus
 */
export function computeEI(params: EIParams): number {
  const { importance, accessCount, daysSinceAccess, coOccurrences } = params;

  const baseWeight = importance / 5;
  const accessFactor = Math.max(1, Math.log(1 + accessCount));
  const effectiveHalfLife = getHalfLife(importance) * (1 + 0.15 * accessCount);
  const decayFactor = Math.pow(0.5, daysSinceAccess / effectiveHalfLife);
  const connectivityBonus = 1 + 0.1 * Math.min(coOccurrences, 5);

  return baseWeight * accessFactor * decayFactor * connectivityBonus;
}

// =============================================================================
// Immunity Check
// =============================================================================

const NINETY_DAYS_MS = 90 * 86400 * 1000;

/**
 * Returns true if an observation is immune from pruning.
 *
 * Immune when:
 * - importance >= 5 (critical), OR
 * - accessCount >= 3 AND last accessed within 90 days
 *
 * The 90-day recency guard prevents immortal stale records.
 */
export function isImmune(
  importance: number,
  accessCount: number,
  lastAccessedEpoch: number | null,
): boolean {
  if (importance >= 5) return true;
  if (accessCount >= 3) {
    if (lastAccessedEpoch !== null && Date.now() - lastAccessedEpoch < NINETY_DAYS_MS) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// Pruning
// =============================================================================

interface ObservationForPruning {
  id: number;
  importance: number;
  access_count: number;
  last_accessed_at_epoch: number | null;
  timestamp_epoch: number;
}

const PRUNE_THRESHOLD = 1000;
const PRUNE_BATCH = 10;

/**
 * Soft-delete lowest-EI non-immune observations when count exceeds 1000.
 * Never throws — returns { pruned: 0, remaining: 0 } on error.
 */
export function pruneObservations(
  db: Database.Database,
  project?: string,
): { pruned: number; remaining: number } {
  const startMs = Date.now();
  try {
    // Count non-deleted observations
    const countSql = project
      ? `SELECT COUNT(*) as cnt FROM observations WHERE deleted_at_epoch IS NULL AND project = ?`
      : `SELECT COUNT(*) as cnt FROM observations WHERE deleted_at_epoch IS NULL`;

    const countRow = project
      ? (db.prepare(countSql).get(project) as { cnt: number })
      : (db.prepare(countSql).get() as { cnt: number });

    const total = countRow?.cnt ?? 0;

    if (total <= PRUNE_THRESHOLD) {
      recordMetric('decay.prune', Date.now() - startMs);
      return { pruned: 0, remaining: total };
    }

    // Fetch all non-deleted observations for EI scoring
    const fetchSql = project
      ? `SELECT id, importance, access_count, last_accessed_at_epoch, timestamp_epoch
         FROM observations
         WHERE deleted_at_epoch IS NULL AND project = ?`
      : `SELECT id, importance, access_count, last_accessed_at_epoch, timestamp_epoch
         FROM observations
         WHERE deleted_at_epoch IS NULL`;

    const rows = project
      ? (db.prepare(fetchSql).all(project) as ObservationForPruning[])
      : (db.prepare(fetchSql).all() as ObservationForPruning[]);

    const nowMs = Date.now();

    // Compute EI for each, tag with immunity
    const scored = rows.map(row => {
      const daysSinceAccess = row.last_accessed_at_epoch !== null
        ? (nowMs - row.last_accessed_at_epoch) / 86400000
        : (nowMs - row.timestamp_epoch) / 86400000;

      const ei = computeEI({
        importance: row.importance,
        accessCount: row.access_count ?? 0,
        daysSinceAccess: Math.max(0, daysSinceAccess),
        coOccurrences: 0,
      });

      const immune = isImmune(
        row.importance,
        row.access_count ?? 0,
        row.last_accessed_at_epoch,
      );

      return { id: row.id, ei, immune };
    });

    // Sort ascending by EI — lowest first
    scored.sort((a, b) => a.ei - b.ei);

    // Soft-delete up to PRUNE_BATCH non-immune lowest-EI records
    const toDelete = scored.filter(s => !s.immune).slice(0, PRUNE_BATCH);

    if (toDelete.length === 0) {
      recordMetric('decay.prune', Date.now() - startMs);
      return { pruned: 0, remaining: total };
    }

    const nowEpoch = Date.now();
    const ids = toDelete.map(s => s.id);
    const placeholders = ids.map(() => '?').join(', ');
    db.prepare(
      `UPDATE observations SET deleted_at_epoch = ? WHERE id IN (${placeholders})`
    ).run(nowEpoch, ...ids);

    recordMetric('decay.prune', Date.now() - startMs);
    return { pruned: toDelete.length, remaining: total - toDelete.length };
  } catch (err) {
    recordMetric('decay.prune', Date.now() - startMs, true);
    log.error('Failed to prune observations:', err);
    return { pruned: 0, remaining: 0 };
  }
}
