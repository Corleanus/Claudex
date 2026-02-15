/**
 * Claudex v2 — Pressure Score CRUD Operations
 *
 * All functions are safe — they catch errors internally and return
 * empty/default results on failure. Errors are logged, never thrown.
 */

import type Database from 'better-sqlite3';
import type { PressureScore, TemperatureLevel } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';

const log = createLogger('pressure');

/** Sentinel value for global scope (no project). Avoids NULL in UNIQUE index. */
const GLOBAL_PROJECT_SENTINEL = '__global__';

/** Row shape returned by SQLite before hydration */
interface PressureRow {
  id: number;
  file_path: string;
  project: string;
  raw_pressure: number;
  temperature: string;
  last_accessed_epoch: number | null;
  decay_rate: number;
  updated_at: string;
  updated_at_epoch: number;
}

function rowToPressureScore(row: PressureRow): PressureScore {
  return {
    id: row.id,
    file_path: row.file_path,
    project: row.project,
    raw_pressure: row.raw_pressure,
    temperature: row.temperature as TemperatureLevel,
    last_accessed_epoch: row.last_accessed_epoch ?? undefined,
    decay_rate: row.decay_rate,
    updated_at: row.updated_at,
    updated_at_epoch: row.updated_at_epoch,
  };
}

/**
 * Insert or update a pressure score (keyed by file_path + project).
 * Uses INSERT OR REPLACE with the unique index on (file_path, project).
 */
export function upsertPressureScore(
  db: Database.Database,
  score: Omit<PressureScore, 'id' | 'updated_at' | 'updated_at_epoch'>,
): void {
  const startMs = Date.now();
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    db.prepare(`
      INSERT OR REPLACE INTO pressure_scores (
        file_path, project, raw_pressure, temperature,
        last_accessed_epoch, decay_rate,
        updated_at, updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      score.file_path,
      score.project ?? GLOBAL_PROJECT_SENTINEL,
      score.raw_pressure,
      score.temperature,
      score.last_accessed_epoch ?? null,
      score.decay_rate,
      now,
      nowEpoch,
    );
    recordMetric('db.insert', Date.now() - startMs);
  } catch (err) {
    recordMetric('db.insert', Date.now() - startMs, true);
    log.error('Failed to upsert pressure score:', err);
  }
}

/**
 * Get all pressure scores, optionally filtered by project.
 * Ordered by raw_pressure DESC.
 */
export function getPressureScores(db: Database.Database, project?: string): PressureScore[] {
  const startMs = Date.now();
  try {
    const sql = project
      ? `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         WHERE project = ?
         ORDER BY raw_pressure DESC`
      : `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         ORDER BY raw_pressure DESC`;

    const rows = project
      ? db.prepare(sql).all(project) as PressureRow[]
      : db.prepare(sql).all() as PressureRow[];

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToPressureScore);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get pressure scores:', err);
    return [];
  }
}

/**
 * Get only HOT files. Ordered by raw_pressure DESC.
 */
export function getHotFiles(db: Database.Database, project?: string): PressureScore[] {
  const startMs = Date.now();
  try {
    const sql = project
      ? `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         WHERE temperature = 'HOT' AND project = ?
         ORDER BY raw_pressure DESC`
      : `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         WHERE temperature = 'HOT'
         ORDER BY raw_pressure DESC`;

    const rows = project
      ? db.prepare(sql).all(project) as PressureRow[]
      : db.prepare(sql).all() as PressureRow[];

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToPressureScore);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get hot files:', err);
    return [];
  }
}

/**
 * Get only WARM files. Ordered by raw_pressure DESC.
 */
export function getWarmFiles(db: Database.Database, project?: string): PressureScore[] {
  const startMs = Date.now();
  try {
    const sql = project
      ? `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         WHERE temperature = 'WARM' AND project = ?
         ORDER BY raw_pressure DESC`
      : `SELECT id, file_path, project, raw_pressure, temperature,
                last_accessed_epoch, decay_rate, updated_at, updated_at_epoch
         FROM pressure_scores
         WHERE temperature = 'WARM'
         ORDER BY raw_pressure DESC`;

    const rows = project
      ? db.prepare(sql).all(project) as PressureRow[]
      : db.prepare(sql).all() as PressureRow[];

    recordMetric('db.query', Date.now() - startMs);
    return rows.map(rowToPressureScore);
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to get warm files:', err);
    return [];
  }
}

/**
 * Apply decay to all pressure scores: raw_pressure = raw_pressure * (1 - decay_rate)
 * Update temperature based on new pressure: >= 0.7 HOT, >= 0.3 WARM, else COLD
 * Update updated_at and updated_at_epoch.
 * Returns number of rows updated. Returns 0 on error.
 */
export function decayAllScores(db: Database.Database, project?: string): number {
  const startMs = Date.now();
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    const sql = project
      ? `UPDATE pressure_scores
         SET raw_pressure = raw_pressure * (1.0 - decay_rate),
             temperature = CASE
               WHEN raw_pressure * (1.0 - decay_rate) >= 0.7 THEN 'HOT'
               WHEN raw_pressure * (1.0 - decay_rate) >= 0.3 THEN 'WARM'
               ELSE 'COLD'
             END,
             updated_at = ?,
             updated_at_epoch = ?
         WHERE project = ?`
      : `UPDATE pressure_scores
         SET raw_pressure = raw_pressure * (1.0 - decay_rate),
             temperature = CASE
               WHEN raw_pressure * (1.0 - decay_rate) >= 0.7 THEN 'HOT'
               WHEN raw_pressure * (1.0 - decay_rate) >= 0.3 THEN 'WARM'
               ELSE 'COLD'
             END,
             updated_at = ?,
             updated_at_epoch = ?`;

    const result = project
      ? db.prepare(sql).run(now, nowEpoch, project)
      : db.prepare(sql).run(now, nowEpoch);

    recordMetric('db.query', Date.now() - startMs);
    return result.changes;
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to decay pressure scores:', err);
    return 0;
  }
}
