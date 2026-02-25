/**
 * Claudex v2 — Retention Policy Enforcement
 *
 * Age-based cleanup logic for observations, reasoning chains,
 * consensus decisions, and pressure scores. Runs on session-end.
 *
 * Key invariants:
 * - Never throws — returns partial results on error
 * - Active consensus decisions ('proposed', 'agreed') are NEVER deleted
 * - FTS5 rebuild only when something was actually deleted
 * - timestamp_epoch is ALWAYS milliseconds
 * - retention_days=0 means "purge everything immediately" (valid)
 */

import type Database from 'better-sqlite3';
import { deleteOldObservations } from '../db/observations.js';
import { rebuildSearchIndex } from '../db/search.js';
import { createLogger } from '../shared/logger.js';
import type { ClaudexConfig } from '../shared/types.js';

const log = createLogger('retention');

export interface RetentionResult {
  observationsDeleted: number;
  reasoningDeleted: number;
  consensusDeleted: number;
  pressureDecayed: number;
  mirrorsCleanedUp: number;
  durationMs: number;
}

export function enforceRetention(db: Database.Database, config: ClaudexConfig): RetentionResult {
  const start = Date.now();
  const retentionDays = config.observation?.retention_days ?? 90;
  const cutoffEpoch = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

  const result: RetentionResult = {
    observationsDeleted: 0,
    reasoningDeleted: 0,
    consensusDeleted: 0,
    pressureDecayed: 0,
    mirrorsCleanedUp: 0,
    durationMs: 0,
  };

  try {
    // Delete old observations
    result.observationsDeleted = deleteOldObservations(db, cutoffEpoch);

    // Delete old reasoning chains
    result.reasoningDeleted = deleteOldReasoning(db, cutoffEpoch);

    // Delete old consensus decisions (only 'rejected' or 'superseded')
    result.consensusDeleted = deleteStaleConsensus(db, cutoffEpoch);

    // Decay pressure scores for files not accessed within retention window
    result.pressureDecayed = decayStaleScores(db, cutoffEpoch);

    // Rebuild FTS5 indexes after bulk deletes
    if (result.observationsDeleted > 0 || result.reasoningDeleted > 0 || result.consensusDeleted > 0) {
      rebuildSearchIndex(db);
    }
  } catch (err) {
    // Never crash — log and return partial results
    log.error('Error during cleanup:', err);
  }

  result.durationMs = Date.now() - start;
  return result;
}

function deleteOldReasoning(db: Database.Database, cutoffEpoch: number): number {
  try {
    const stmt = db.prepare('DELETE FROM reasoning_chains WHERE timestamp_epoch < ?');
    return stmt.run(cutoffEpoch).changes;
  } catch { return 0; }
}

function deleteStaleConsensus(db: Database.Database, cutoffEpoch: number): number {
  try {
    // Only delete rejected/superseded decisions older than retention
    // Active ('proposed', 'agreed') decisions are preserved regardless of age
    const stmt = db.prepare(
      "DELETE FROM consensus_decisions WHERE timestamp_epoch < ? AND status IN ('rejected', 'superseded')"
    );
    return stmt.run(cutoffEpoch).changes;
  } catch { return 0; }
}

function decayStaleScores(db: Database.Database, cutoffEpoch: number): number {
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();
    // Zero out pressure for files not accessed within retention window
    // Handle NULL last_accessed_epoch (never accessed = stale)
    // Update timestamps to maintain schema consistency
    const stmt = db.prepare(
      `UPDATE pressure_scores
       SET raw_pressure = 0, temperature = 'COLD', updated_at = ?, updated_at_epoch = ?
       WHERE last_accessed_epoch IS NULL OR last_accessed_epoch < ?`
    );
    return stmt.run(now, nowEpoch, cutoffEpoch).changes;
  } catch { return 0; }
}
