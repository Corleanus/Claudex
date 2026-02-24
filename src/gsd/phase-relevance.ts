/**
 * Claudex v2 -- Phase Relevance Engine
 *
 * Extracts files_modified from plan YAML frontmatter, builds tiered
 * phase relevance sets, and applies post-query boost multipliers to
 * pressure scores. Phase-relevant files rank higher in context injection
 * without hiding non-phase activity.
 *
 * Never throws -- returns empty/unchanged on any error (Claudex convention).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../shared/logger.js';
import { findPhaseDir } from './state-reader.js';
import type { PhaseRelevanceSet } from './types.js';
import type { ScoredFile, TemperatureLevel } from '../shared/types.js';

const log = createLogger('gsd-phase-relevance');

// =============================================================================
// Constants
// =============================================================================

/** Full boost multiplier for files in the active plan */
export const ACTIVE_PLAN_BOOST = 1.4;

/** Partial boost multiplier for files in other plans of the same phase */
export const OTHER_PLAN_BOOST = 1.2;

/** Temperature thresholds (from pressure.ts: accumulatePressureScore) */
const HOT_THRESHOLD = 0.7;
const WARM_THRESHOLD = 0.3;

// =============================================================================
// Regex Patterns
// =============================================================================

const FM_PATTERN = /^---\n([\s\S]*?)\n---/;
const FILES_MODIFIED_PATTERN = /files_modified:\s*\n((?:\s+- .+\n?)+)/;

// =============================================================================
// extractPlanFilesModified
// =============================================================================

/**
 * Extract the `files_modified` list from YAML frontmatter in a plan file.
 * Follows the exact pattern from extractPlanMustHaves() in state-reader.ts:
 * read file, normalize CRLF, extract YAML frontmatter, parse list items.
 * Returns an array of file paths. Never throws -- returns [] on any error.
 */
export function extractPlanFilesModified(planFilePath: string): string[] {
  try {
    const content = fs.readFileSync(planFilePath, 'utf-8').replace(/\r\n/g, '\n');

    const fmMatch = content.match(FM_PATTERN);
    if (!fmMatch) return [];

    const frontmatter = fmMatch[1]!;

    const filesMatch = frontmatter.match(FILES_MODIFIED_PATTERN);
    if (!filesMatch) return [];

    return filesMatch[1]!
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('- '))
      .map(line => {
        let value = line.slice(2).trim();
        // Strip surrounding quotes (double or single)
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        return value;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// =============================================================================
// getPhaseRelevanceSet
// =============================================================================

/**
 * Build a tiered phase relevance set from all plan files in a phase directory.
 * Active plan files go into `activePlanFiles`, other plans' files into
 * `otherPlanFiles`. Completed plans (with matching SUMMARY.md) are excluded.
 *
 * When activePlanNumber === 0: all files go to otherPlanFiles (partial boost
 * only -- no single plan is "active").
 *
 * Never throws -- returns empty sets on any error.
 */
export function getPhaseRelevanceSet(
  phasesDir: string,
  phaseNumber: number,
  activePlanNumber: number,
): PhaseRelevanceSet {
  const activePlanFiles = new Set<string>();
  const otherPlanFiles = new Set<string>();

  try {
    const phaseDir = findPhaseDir(phasesDir, phaseNumber);
    if (!phaseDir) return { activePlanFiles, otherPlanFiles };

    const entries = fs.readdirSync(phaseDir);
    const planFiles = entries.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');

    for (const planFileName of planFiles) {
      // Check if this plan is completed (matching SUMMARY.md exists)
      const summaryName = planFileName.replace('-PLAN.md', '-SUMMARY.md');
      if (entries.includes(summaryName)) {
        log.debug(`Skipping completed plan: ${planFileName}`);
        continue;
      }

      // Extract plan number from filename
      const planNumMatch = planFileName.match(/-(\d+)-PLAN\.md$/);
      const planNum = planNumMatch ? parseInt(planNumMatch[1]!, 10) : 0;
      const isActivePlan = activePlanNumber > 0 && planNum === activePlanNumber;

      // Extract files from this plan
      const planPath = path.join(phaseDir, planFileName);
      const filesModified = extractPlanFilesModified(planPath);

      for (const file of filesModified) {
        if (isActivePlan) {
          activePlanFiles.add(file);
          // Active plan takes precedence -- remove from other if present
          otherPlanFiles.delete(file);
        } else if (!activePlanFiles.has(file)) {
          otherPlanFiles.add(file);
        }
      }
    }

    return { activePlanFiles, otherPlanFiles };
  } catch (e) {
    log.warn('Failed to build phase relevance set', e);
    return { activePlanFiles, otherPlanFiles };
  }
}

// =============================================================================
// applyPhaseBoost
// =============================================================================

/**
 * Classify temperature from raw pressure using pressure.ts thresholds.
 * >= 0.7 -> HOT, >= 0.3 -> WARM, else COLD.
 */
function classifyTemperature(rawPressure: number): TemperatureLevel {
  if (rawPressure >= HOT_THRESHOLD) return 'HOT';
  if (rawPressure >= WARM_THRESHOLD) return 'WARM';
  return 'COLD';
}

/**
 * Apply phase boost multipliers to scored files.
 * Active plan files get ACTIVE_PLAN_BOOST (1.4x), other plan files get
 * OTHER_PLAN_BOOST (1.2x). Boosted scores are capped at 1.0, temperature
 * is reclassified, and results are sorted by raw_pressure descending.
 *
 * Returns a new array (does not mutate input). Non-boosted files are
 * returned unchanged with no phase_boosted field.
 *
 * Never throws -- returns input unchanged on any error.
 */
export function applyPhaseBoost(
  scores: ScoredFile[],
  relevance: PhaseRelevanceSet,
): ScoredFile[] {
  try {
    // Short-circuit: if no relevance data, return as-is (no copy, no sort)
    if (relevance.activePlanFiles.size === 0 && relevance.otherPlanFiles.size === 0) {
      return scores;
    }

    const result = scores.map(score => {
      let multiplier = 1.0;
      let boosted = false;

      if (relevance.activePlanFiles.has(score.path)) {
        multiplier = ACTIVE_PLAN_BOOST;
        boosted = true;
      } else if (relevance.otherPlanFiles.has(score.path)) {
        multiplier = OTHER_PLAN_BOOST;
        boosted = true;
      }

      if (!boosted) return score;

      const boostedPressure = Math.min(1.0, score.raw_pressure * multiplier);
      return {
        ...score,
        raw_pressure: boostedPressure,
        temperature: classifyTemperature(boostedPressure),
        phase_boosted: true as const,
      };
    });

    // Re-sort by raw_pressure descending (boost may change ranking)
    result.sort((a, b) => b.raw_pressure - a.raw_pressure);

    return result;
  } catch (e) {
    log.warn('Failed to apply phase boost', e);
    return scores;
  }
}
