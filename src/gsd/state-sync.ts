/**
 * Claudex v2 -- Bidirectional State Sync
 *
 * Two-way sync between Claudex cognitive state and GSD STATE.md:
 * - getClaudexMetrics(): pure function returning typed metrics from DB
 * - writeClaudexMetricsToState(): reads STATE.md, replaces/appends Claudex Metrics section
 *
 * Never throws -- both functions return defaults on error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from '../shared/logger.js';
import { getHotFiles, getWarmFiles } from '../db/pressure.js';

const log = createLogger('gsd-state-sync');

// =============================================================================
// Types
// =============================================================================

interface ClaudexMetrics {
  observationCount: number;
  topFiles: Array<{ path: string; pressure: number; temperature: string }>;
  coveragePct: number;
  updatedAt: string;
}

// =============================================================================
// getClaudexMetrics
// =============================================================================

/**
 * Compute Claudex cognitive metrics from the database.
 * Returns typed metrics object. Never throws.
 */
export function getClaudexMetrics(db: Database.Database, projectName: string): ClaudexMetrics {
  const defaults: ClaudexMetrics = {
    observationCount: 0,
    topFiles: [],
    coveragePct: 0,
    updatedAt: new Date().toISOString(),
  };

  try {
    // 1. Observation count
    const countRow = db.prepare(
      `SELECT COUNT(*) AS cnt FROM observations WHERE project = ? AND deleted_at_epoch IS NULL`,
    ).get(projectName) as { cnt: number } | undefined;
    const observationCount = countRow?.cnt ?? 0;

    // 2. Top files: HOT + WARM, sorted by pressure desc, max 5
    const hotFiles = getHotFiles(db, projectName);
    const warmFiles = getWarmFiles(db, projectName);
    const combined = [...hotFiles, ...warmFiles]
      .sort((a, b) => b.raw_pressure - a.raw_pressure)
      .slice(0, 5)
      .map(f => ({ path: f.file_path, pressure: f.raw_pressure, temperature: f.temperature }));

    // 3. Coverage percentage
    let coveragePct = 0;

    // Numerator: distinct file paths with pressure scores
    const numRow = db.prepare(
      `SELECT COUNT(DISTINCT file_path) AS cnt FROM pressure_scores WHERE project = ?`,
    ).get(projectName) as { cnt: number } | undefined;
    const numerator = numRow?.cnt ?? 0;

    // Denominator: distinct file paths from non-deleted observations
    const obsRows = db.prepare(
      `SELECT files_read, files_modified FROM observations WHERE project = ? AND deleted_at_epoch IS NULL`,
    ).all(projectName) as Array<{ files_read: string | null; files_modified: string | null }>;

    const allFiles = new Set<string>();
    for (const row of obsRows) {
      if (row.files_read) {
        try {
          const parsed = JSON.parse(row.files_read) as string[];
          for (const f of parsed) allFiles.add(f);
        } catch { /* skip malformed */ }
      }
      if (row.files_modified) {
        try {
          const parsed = JSON.parse(row.files_modified) as string[];
          for (const f of parsed) allFiles.add(f);
        } catch { /* skip malformed */ }
      }
    }

    const denominator = allFiles.size;
    if (denominator > 0) {
      coveragePct = Math.round(numerator / denominator * 100);
    }

    return {
      observationCount,
      topFiles: combined,
      coveragePct,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    log.warn('getClaudexMetrics failed, returning defaults', err);
    return defaults;
  }
}

// =============================================================================
// writeClaudexMetricsToState
// =============================================================================

/**
 * Write Claudex cognitive metrics to the Claudex Metrics section of STATE.md.
 * Replaces existing section or appends if missing. Atomic write via tmp+rename.
 * Returns true on success, false on error or missing STATE.md. Never throws.
 */
export function writeClaudexMetricsToState(
  projectDir: string,
  projectName: string,
  db: Database.Database,
): boolean {
  try {
    const stateMdPath = path.join(projectDir, '.planning', 'STATE.md');

    // If STATE.md doesn't exist, return false (don't create it)
    if (!fs.existsSync(stateMdPath)) {
      return false;
    }

    // Read file content
    let content = fs.readFileSync(stateMdPath, 'utf-8');

    // Detect CRLF
    const useCRLF = content.includes('\r\n');

    // Normalize to LF for regex processing
    if (useCRLF) {
      content = content.replace(/\r\n/g, '\n');
    }

    // Get metrics
    const metrics = getClaudexMetrics(db, projectName);

    // Build top files display
    let topFilesStr = 'None';
    if (metrics.topFiles.length > 0) {
      topFilesStr = metrics.topFiles
        .map(f => `\`${f.path}\` (${f.temperature} ${f.pressure.toFixed(2)})`)
        .join(', ');
    }

    // Count files for coverage detail
    const numRow = ((): number => {
      try {
        const row = db.prepare(
          `SELECT COUNT(DISTINCT file_path) AS cnt FROM pressure_scores WHERE project = ?`,
        ).get(projectName) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
      } catch {
        return 0;
      }
    })();

    const obsRows = ((): number => {
      try {
        const rows = db.prepare(
          `SELECT files_read, files_modified FROM observations WHERE project = ? AND deleted_at_epoch IS NULL`,
        ).all(projectName) as Array<{ files_read: string | null; files_modified: string | null }>;
        const allFiles = new Set<string>();
        for (const row of rows) {
          if (row.files_read) {
            try {
              const parsed = JSON.parse(row.files_read) as string[];
              for (const f of parsed) allFiles.add(f);
            } catch { /* skip */ }
          }
          if (row.files_modified) {
            try {
              const parsed = JSON.parse(row.files_modified) as string[];
              for (const f of parsed) allFiles.add(f);
            } catch { /* skip */ }
          }
        }
        return allFiles.size;
      } catch {
        return 0;
      }
    })();

    // Build metrics section
    let metricsSection = `## Claudex Metrics\n`;
    metricsSection += `<!-- AUTO-GENERATED by Claudex. Do not edit manually. -->\n`;
    metricsSection += `| Metric | Value |\n`;
    metricsSection += `|--------|-------|\n`;
    metricsSection += `| Observations | ${metrics.observationCount} |\n`;
    metricsSection += `| Top Files | ${topFilesStr} |\n`;
    metricsSection += `| Coverage | ${metrics.coveragePct}% (${numRow}/${obsRows} files tracked) |\n`;
    metricsSection += `| Updated | ${metrics.updatedAt} |\n`;

    // Section replacement regex: match from ## Claudex Metrics to next ## or EOF
    const sectionRegex = /## Claudex Metrics\n[\s\S]*?(?=\n## |\n*$)/;

    if (sectionRegex.test(content)) {
      content = content.replace(sectionRegex, metricsSection.trimEnd());
    } else {
      // Append to end
      content = content.trimEnd() + '\n\n' + metricsSection;
    }

    // Restore CRLF if original used it
    if (useCRLF) {
      content = content.replace(/\n/g, '\r\n');
    }

    // Atomic write: write to tmp, then rename
    const tmpPath = stateMdPath + '.claudex-tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, stateMdPath);

    log.debug('Claudex metrics written to STATE.md');
    return true;
  } catch (err) {
    log.warn('writeClaudexMetricsToState failed', err);
    return false;
  }
}
