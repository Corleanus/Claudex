/**
 * Claudex v2 -- Summary Writer
 *
 * Generates phase-relevant ranked file lists as markdown and writes to
 * `.planning/context/SUMMARY.md`. GSD agents read this file directly
 * for pressure-ranked file data without hooks or APIs.
 *
 * Never throws -- returns false on any error (Claudex convention).
 * Uses sync file operations (matching flat-file-mirror.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { getPressureScores } from '../db/pressure.js';
import { getPhaseRelevanceSet, applyPhaseBoost } from './phase-relevance.js';
import type { GsdState } from './types.js';
import type { ScoredFile } from '../shared/types.js';
import type Database from 'better-sqlite3';

const log = createLogger('gsd-summary-writer');

// =============================================================================
// Constants
// =============================================================================

/** Minimum time between SUMMARY.md rewrites (5 minutes) */
const DEBOUNCE_MS = 5 * 60 * 1000;

// =============================================================================
// writePhaseSummary
// =============================================================================

/**
 * Generate and write a phase-relevant ranked file summary to
 * `.planning/context/SUMMARY.md`.
 *
 * Returns `true` if the file was written, `false` if skipped (debounce,
 * inactive GSD, error).
 *
 * @param projectDir - Project root directory (contains `.planning/`)
 * @param projectName - Project scope name (passed to getPressureScores)
 * @param db - SQLite database handle
 * @param gsdState - Current GSD state from state-reader
 */
export function writePhaseSummary(
  projectDir: string,
  projectName: string,
  db: Database.Database,
  gsdState: GsdState,
): boolean {
  try {
    // Guard: inactive GSD or no position
    if (!gsdState.active || !gsdState.position) return false;

    const contextDir = path.join(projectDir, '.planning', 'context');
    const summaryPath = path.join(contextDir, 'SUMMARY.md');

    // Debounce gate: skip if file is fresh (< 5 min old)
    try {
      const stat = fs.statSync(summaryPath);
      if (Date.now() - stat.mtimeMs < DEBOUNCE_MS) return false;
    } catch {
      // File doesn't exist -- proceed to write
    }

    const position = gsdState.position;

    // Query pressure scores
    const pressureScores = getPressureScores(db, projectName);

    // Map to ScoredFile[]
    const scoredFiles: ScoredFile[] = pressureScores.map(s => ({
      path: s.file_path,
      raw_pressure: s.raw_pressure,
      temperature: s.temperature,
      system_bucket: 0,
      pressure_bucket: 0,
    }));

    // Get phase relevance set
    const phasesDir = path.join(projectDir, '.planning', 'phases');
    const relevanceSet = getPhaseRelevanceSet(phasesDir, position.phase, position.plan);

    // Apply phase boost
    const boostedFiles = applyPhaseBoost(scoredFiles, relevanceSet);

    // Split into phase-relevant (boosted) and other notable (WARM+ non-boosted)
    const phaseFiles = boostedFiles
      .filter(f => f.phase_boosted === true)
      .sort((a, b) => b.raw_pressure - a.raw_pressure);

    const otherFiles = boostedFiles
      .filter(f => f.phase_boosted !== true && f.temperature !== 'COLD')
      .sort((a, b) => b.raw_pressure - a.raw_pressure);

    // Count WARM+ files total
    const warmPlusCount = boostedFiles.filter(f => f.temperature !== 'COLD').length;

    // Format markdown
    const phaseName = position.phaseName || `Phase ${position.phase}`;
    const timestamp = new Date().toISOString();

    let content = `# Phase Summary\n\n`;
    content += `**Phase:** ${position.phase} — ${phaseName}\n`;
    content += `**Updated:** ${timestamp}\n`;
    content += `**Files:** ${warmPlusCount} tracked (${phaseFiles.length} phase-relevant)\n\n`;

    // Phase-Relevant Files section
    content += `## Phase-Relevant Files\n\n`;
    if (phaseFiles.length > 0) {
      content += `| File | Pressure | Temp |\n`;
      content += `|------|----------|------|\n`;
      for (const f of phaseFiles) {
        content += `| \`${f.path}\` | ${f.raw_pressure.toFixed(2)} | ${f.temperature} |\n`;
      }
    } else {
      content += `_No phase-relevant files detected._\n`;
    }

    content += `\n`;

    // Other Notable Files section
    content += `## Other Notable Files\n\n`;
    if (otherFiles.length > 0) {
      content += `| File | Pressure | Temp |\n`;
      content += `|------|----------|------|\n`;
      for (const f of otherFiles) {
        content += `| \`${f.path}\` | ${f.raw_pressure.toFixed(2)} | ${f.temperature} |\n`;
      }
    } else {
      content += `_No additional notable files._\n`;
    }

    // Write to disk
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(summaryPath, content, 'utf-8');

    return true;
  } catch (e) {
    log.warn('Failed to write phase summary', e);
    return false;
  }
}

// =============================================================================
// archivePhaseSummary
// =============================================================================

/**
 * Archive SUMMARY.md to `.planning/context/archive/{NN}-{name}.md`
 * and delete the original.
 *
 * Returns `true` if archived, `false` if no SUMMARY.md exists or error.
 *
 * @param projectDir - Project root directory
 * @param phaseNumber - Phase number (zero-padded to 2 digits)
 * @param phaseName - Phase slug name (e.g., 'summary-generation')
 */
export function archivePhaseSummary(
  projectDir: string,
  phaseNumber: number,
  phaseName: string,
): boolean {
  try {
    const contextDir = path.join(projectDir, '.planning', 'context');
    const summaryPath = path.join(contextDir, 'SUMMARY.md');

    if (!fs.existsSync(summaryPath)) return false;

    const archiveDir = path.join(contextDir, 'archive');
    const paddedPhase = String(phaseNumber).padStart(2, '0');
    const archivePath = path.join(archiveDir, `${paddedPhase}-${phaseName}.md`);

    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(summaryPath, archivePath);
    fs.unlinkSync(summaryPath);

    return true;
  } catch (e) {
    log.warn('Failed to archive phase summary', e);
    return false;
  }
}
