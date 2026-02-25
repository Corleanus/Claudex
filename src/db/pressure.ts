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
import { ensureEpochMs } from '../shared/epoch.js';

const log = createLogger('pressure');

/** Sentinel value for global scope (no project). Avoids NULL in UNIQUE index. */
const GLOBAL_PROJECT_SENTINEL = '__global__';

/** Reserved project name that conflicts with the sentinel. Must be rejected or mapped. */
const RESERVED_PROJECT_NAME = '__global__';

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
    // Guard against reserved project name collision
    if (score.project === RESERVED_PROJECT_NAME) {
      log.warn(`Project name "${RESERVED_PROJECT_NAME}" is reserved and conflicts with internal sentinel. Skipping upsert for file: ${score.file_path}`);
      recordMetric('db.insert', Date.now() - startMs);
      return;
    }

    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    db.prepare(`
      INSERT INTO pressure_scores (
        file_path, project, raw_pressure, temperature,
        last_accessed_epoch, decay_rate,
        updated_at, updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, project) DO UPDATE SET
        raw_pressure = excluded.raw_pressure,
        temperature = excluded.temperature,
        last_accessed_epoch = excluded.last_accessed_epoch,
        decay_rate = excluded.decay_rate,
        updated_at = excluded.updated_at,
        updated_at_epoch = excluded.updated_at_epoch
    `).run(
      score.file_path,
      score.project ?? GLOBAL_PROJECT_SENTINEL,
      score.raw_pressure,
      score.temperature,
      score.last_accessed_epoch !== undefined ? ensureEpochMs(score.last_accessed_epoch) : null,
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
 * Accumulate pressure for a file path with diminishing returns.
 *
 * Uses INSERT ... ON CONFLICT DO UPDATE so a single SQL statement handles
 * both new files (INSERT) and existing files (UPDATE).
 *
 * Diminishing-returns formula: new_pressure = MIN(1.0, old + increment * (1.0 - old))
 * Each successive touch adds less because (1.0 - old) shrinks as old grows.
 *
 * Default decay_rate for new rows is 0.05.
 */
export function accumulatePressureScore(
  db: Database.Database,
  filePath: string,
  project: string | undefined,
  increment: number,
): void {
  const startMs = Date.now();
  try {
    const resolvedProject = project ?? GLOBAL_PROJECT_SENTINEL;

    // Guard against reserved project name collision
    if (project === RESERVED_PROJECT_NAME) {
      log.warn(`Project name "${RESERVED_PROJECT_NAME}" is reserved and conflicts with internal sentinel. Skipping accumulate for file: ${filePath}`);
      recordMetric('db.insert', Date.now() - startMs);
      return;
    }

    // Clamp increment to [0, 1] — defensive against invalid values
    const safeIncrement = Math.max(0, Math.min(1, Number.isFinite(increment) ? increment : 0));
    if (safeIncrement === 0) return;

    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    // Compute initial temperature from the increment value (for INSERT case)
    const initialTemp: TemperatureLevel =
      safeIncrement >= 0.7 ? 'HOT' : safeIncrement >= 0.3 ? 'WARM' : 'COLD';

    const defaultDecayRate = 0.05;

    db.prepare(`
      INSERT INTO pressure_scores (
        file_path, project, raw_pressure, temperature,
        last_accessed_epoch, decay_rate,
        updated_at, updated_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, project) DO UPDATE SET
        raw_pressure = MIN(1.0, pressure_scores.raw_pressure + ? * (1.0 - pressure_scores.raw_pressure)),
        temperature = CASE
          WHEN MIN(1.0, pressure_scores.raw_pressure + ? * (1.0 - pressure_scores.raw_pressure)) >= 0.7 THEN 'HOT'
          WHEN MIN(1.0, pressure_scores.raw_pressure + ? * (1.0 - pressure_scores.raw_pressure)) >= 0.3 THEN 'WARM'
          ELSE 'COLD'
        END,
        last_accessed_epoch = excluded.last_accessed_epoch,
        updated_at = excluded.updated_at,
        updated_at_epoch = excluded.updated_at_epoch
    `).run(
      filePath,
      resolvedProject,
      safeIncrement,      // initial raw_pressure for INSERT
      initialTemp,        // initial temperature for INSERT
      nowEpoch,           // last_accessed_epoch
      defaultDecayRate,   // decay_rate for INSERT
      now,                // updated_at
      nowEpoch,           // updated_at_epoch
      safeIncrement,      // ON CONFLICT: increment * (1.0 - old)
      safeIncrement,      // CASE WHEN branch 1
      safeIncrement,      // CASE WHEN branch 2
    );
    recordMetric('db.insert', Date.now() - startMs);
  } catch (err) {
    recordMetric('db.insert', Date.now() - startMs, true);
    log.error('Failed to accumulate pressure score:', err);
  }
}

/**
 * Apply stratified decay to all pressure scores.
 *
 * Four tiers with different daily decay factors derived from Kore half-lives:
 *   Critical (>= 0.85): 0.99810  (half-life ~365d)
 *   High     (>= 0.70): 0.99232  (half-life ~90d)
 *   Medium   (>= 0.40): 0.97716  (half-life ~30d)
 *   Low      (< 0.40):  0.90572  (half-life ~7d)
 *
 * Idempotent: each row only decays once per calendar day (last_decay_epoch guard).
 * The `decay_rate` column is retained for backward compatibility but unused.
 * Returns total rows updated across all tiers. Returns 0 on error.
 */
export function decayAllScores(db: Database.Database, project?: string): number {
  const startMs = Date.now();
  try {
    const now = new Date().toISOString();
    const nowEpoch = Date.now();

    // Start of today in epoch ms — used as the idempotency threshold
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStartEpoch = today.getTime();

    const tempExpr = (pressureExpr: string) => `
      CASE
        WHEN ${pressureExpr} >= 0.7 THEN 'HOT'
        WHEN ${pressureExpr} >= 0.3 THEN 'WARM'
        ELSE 'COLD'
      END
    `;

    const idempotencyClause = `(last_decay_epoch IS NULL OR last_decay_epoch < ?)`;

    const tiers: Array<{ factor: number; minPressure: number | null; maxPressure: number | null }> = [
      { factor: 0.99810, minPressure: 0.85, maxPressure: null },
      { factor: 0.99232, minPressure: 0.70, maxPressure: 0.85 },
      { factor: 0.97716, minPressure: 0.40, maxPressure: 0.70 },
      { factor: 0.90572, minPressure: null, maxPressure: 0.40 },
    ];

    let totalChanged = 0;

    for (const tier of tiers) {
      const whereConditions: string[] = [idempotencyClause];
      if (tier.minPressure !== null) whereConditions.push(`raw_pressure >= ${tier.minPressure}`);
      if (tier.maxPressure !== null) whereConditions.push(`raw_pressure < ${tier.maxPressure}`);
      if (project) whereConditions.push('project = ?');

      const newPressureExpr = `raw_pressure * ${tier.factor}`;

      // Parameter order: SET params first, then WHERE params
      // SET: last_decay_epoch=?, updated_at=?, updated_at_epoch=?
      // WHERE: todayStartEpoch (idempotency), [project]
      const sql = `
        UPDATE pressure_scores
        SET raw_pressure = ${newPressureExpr},
            temperature = ${tempExpr(newPressureExpr)},
            last_decay_epoch = ?,
            updated_at = ?,
            updated_at_epoch = ?
        WHERE ${whereConditions.join(' AND ')}
      `;

      const runParams: unknown[] = [
        nowEpoch,           // last_decay_epoch = ?
        now,                // updated_at = ?
        nowEpoch,           // updated_at_epoch = ?
        todayStartEpoch,    // idempotency: last_decay_epoch < ?
      ];
      if (project) runParams.push(project);

      const result = db.prepare(sql).run(...runParams);
      totalChanged += result.changes;
    }

    recordMetric('db.query', Date.now() - startMs);
    return totalChanged;
  } catch (err) {
    recordMetric('db.query', Date.now() - startMs, true);
    log.error('Failed to decay pressure scores:', err);
    return 0;
  }
}
