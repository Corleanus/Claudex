/**
 * Claudex v2 -- GSD State Reader
 *
 * Reads .planning/ files from disk and returns a typed GsdState object.
 * This is the foundational module for all Claudex-GSD integration.
 * Every downstream phase (2-8) depends on this module.
 *
 * Never throws -- returns EMPTY_GSD_STATE on any error (Claudex convention).
 * Uses sync fs operations (matching all other Claudex shared modules).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { GsdCurrentPosition, GsdPhase, GsdPlanSummary, GsdState } from './types.js';
import { EMPTY_GSD_STATE } from './types.js';

const log = createLogger('gsd-state-reader');

// =============================================================================
// Regex Patterns (ported from gsd-tools.cjs)
// =============================================================================

// STATE.md Format A (plain-text)
const POSITION_PATTERN_A = /^Phase:\s*(\d+(?:\.\d+)?)\s+of\s+(\d+)\s*\(([^)]+)\)/m;
const PLAN_PATTERN_A = /^Plan:\s*(\d+)\s+of\s+(\d+|TBD)/m;
const STATUS_PATTERN_A = /^Status:\s*(.+)$/m;

// STATE.md Format B (structured fields)
const fieldPattern = (name: string): RegExp =>
  new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`, 'i');

// ROADMAP.md phase heading
const PHASE_HEADING_PATTERN = /#{2,4}\s*Phase\s+(\d+(?:\.\d+)?)\s*:\s*([^\n]+)/gi;

// ROADMAP.md field extraction (handles both **Field**: and **Field:** formats)
const roadmapField = (name: string): RegExp =>
  new RegExp(`\\*\\*${name}(?:\\*\\*:|:\\*\\*)\\s*([^\\n]+)`, 'i');

// =============================================================================
// parseStateMd
// =============================================================================

/**
 * Parse STATE.md content into a GsdCurrentPosition.
 * Supports Format A (plain-text) and Format B (structured fields).
 * Returns null if neither format can be parsed.
 */
export function parseStateMd(content: string): GsdCurrentPosition | null {
  if (!content || !content.trim()) return null;

  // Normalize CRLF once
  const normalized = content.replace(/\r\n/g, '\n');

  // Try Format B first (more precise)
  const formatB = parseStateMdFormatB(normalized);
  if (formatB) return formatB;

  // Fall back to Format A
  return parseStateMdFormatA(normalized);
}

function parseStateMdFormatB(content: string): GsdCurrentPosition | null {
  const phaseMatch = content.match(fieldPattern('Current Phase'));
  if (!phaseMatch) return null;

  const phaseStr = phaseMatch[1]!.trim();
  const phase = parseFloat(phaseStr);
  if (isNaN(phase)) return null;

  const nameMatch = content.match(fieldPattern('Current Phase Name'));
  const totalMatch = content.match(fieldPattern('Total Phases'));
  const planMatch = content.match(fieldPattern('Current Plan'));
  const totalPlansMatch = content.match(fieldPattern('Total Plans'));
  const statusMatch = content.match(fieldPattern('Status'));

  const totalPhases = totalMatch ? parseInt(totalMatch[1]!.trim(), 10) : 0;
  if (isNaN(totalPhases)) return null;

  const planStr = planMatch ? planMatch[1]!.trim() : '0';
  const plan = parseInt(planStr, 10);

  const totalPlansStr = totalPlansMatch ? totalPlansMatch[1]!.trim() : null;
  const totalPlans = totalPlansStr && totalPlansStr !== 'TBD'
    ? parseInt(totalPlansStr, 10)
    : null;

  return {
    phase,
    totalPhases,
    phaseName: nameMatch ? nameMatch[1]!.trim() : null,
    plan: isNaN(plan) ? 0 : plan,
    totalPlans: totalPlans !== null && isNaN(totalPlans) ? null : totalPlans,
    status: statusMatch ? statusMatch[1]!.trim() : null,
  };
}

function parseStateMdFormatA(content: string): GsdCurrentPosition | null {
  const posMatch = content.match(POSITION_PATTERN_A);
  if (!posMatch) return null;

  const phase = parseFloat(posMatch[1]!);
  const totalPhases = parseInt(posMatch[2]!, 10);
  const phaseName = posMatch[3]!.trim();

  const planMatch = content.match(PLAN_PATTERN_A);
  const plan = planMatch ? parseInt(planMatch[1]!, 10) : 0;
  const totalPlansStr = planMatch ? planMatch[2]!.trim() : null;
  const totalPlans = totalPlansStr && totalPlansStr !== 'TBD'
    ? parseInt(totalPlansStr, 10)
    : null;

  const statusMatch = content.match(STATUS_PATTERN_A);
  const status = statusMatch ? statusMatch[1]!.trim() : null;

  return {
    phase,
    totalPhases,
    phaseName,
    plan: isNaN(plan) ? 0 : plan,
    totalPlans: totalPlans !== null && isNaN(totalPlans) ? null : totalPlans,
    status,
  };
}

// =============================================================================
// parseRoadmapMd
// =============================================================================

/**
 * Parse ROADMAP.md content into an array of GsdPhase objects.
 * Phases are sorted by number (handles decimal phases like 2.1).
 * Returns empty array if no phases can be parsed.
 */
export function parseRoadmapMd(content: string): GsdPhase[] {
  if (!content || !content.trim()) return [];

  // Normalize CRLF once
  const normalized = content.replace(/\r\n/g, '\n');

  const phases: GsdPhase[] = [];

  // Reset regex state (global flag)
  PHASE_HEADING_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  const headings: Array<{ index: number; phaseNum: string; phaseName: string }> = [];

  while ((match = PHASE_HEADING_PATTERN.exec(normalized)) !== null) {
    headings.push({
      index: match.index,
      phaseNum: match[1]!,
      phaseName: match[2]!.replace(/\(INSERTED\)/i, '').trim(),
    });
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const sectionStart = heading.index;
    const sectionEnd = i + 1 < headings.length ? headings[i + 1]!.index : normalized.length;
    const section = normalized.slice(sectionStart, sectionEnd);

    const phaseNumber = parseFloat(heading.phaseNum);
    if (isNaN(phaseNumber)) continue;

    // Goal
    const goalMatch = section.match(roadmapField('Goal'));
    const goal = goalMatch ? goalMatch[1]!.trim() : null;

    // Depends on
    const dependsMatch = section.match(roadmapField('Depends on'));
    const dependsOn = dependsMatch ? dependsMatch[1]!.trim() : null;

    // Requirements
    const reqMatch = section.match(roadmapField('Requirements'));
    const requirements = reqMatch
      ? reqMatch[1]!.split(',')
          .map(s => s.trim())
          .filter(s => /^[A-Z]+-\d+[A-Z]*$/.test(s))
      : [];

    // Success criteria (numbered list)
    const criteriaMatch = section.match(
      /\*\*Success Criteria\*\*[^\n]*:\s*\n((?:\s*\d+\.\s*[^\n]+\n?)+)/i,
    );
    const successCriteria = criteriaMatch
      ? criteriaMatch[1]!.trim().split('\n')
          .map(line => line.replace(/^\s*\d+\.\s*/, '').trim())
          .filter(Boolean)
      : [];

    // Checkbox status from the roadmap checklist
    const escapedPhase = heading.phaseNum.replace('.', '\\.');
    const checkboxPattern = new RegExp(
      `-\\s*\\[(x| )\\]\\s*.*Phase\\s+${escapedPhase}`,
      'i',
    );
    const checkboxMatch = normalized.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? checkboxMatch[1] === 'x' : false;

    phases.push({
      number: phaseNumber,
      name: heading.phaseName,
      goal,
      dependsOn,
      requirements,
      successCriteria,
      roadmapComplete,
      plans: null, // Populated by readGsdState from disk
    });
  }

  // Sort by phase number: major then minor
  phases.sort((a, b) => {
    const [aMaj, aMin] = parsePhaseNumber(a.number);
    const [bMaj, bMin] = parsePhaseNumber(b.number);
    if (aMaj !== bMaj) return aMaj - bMaj;
    return aMin - bMin;
  });

  return phases;
}

/**
 * Parse a phase number into [major, minor] tuple for sorting.
 * e.g., 2.1 -> [2, 1], 3 -> [3, 0], 10 -> [10, 0]
 */
function parsePhaseNumber(num: number): [number, number] {
  const str = String(num);
  const parts = str.split('.');
  return [
    parseInt(parts[0]!, 10),
    parts[1] ? parseInt(parts[1], 10) : 0,
  ];
}

// =============================================================================
// countPlanFiles
// =============================================================================

/**
 * Count plan and summary files in a phase directory.
 * Plans match *-PLAN.md or PLAN.md. Summaries match *-SUMMARY.md or SUMMARY.md.
 * Returns { total: 0, complete: 0 } on error (missing dir, permission error).
 */
export function countPlanFiles(phaseDir: string): GsdPlanSummary {
  try {
    const files = fs.readdirSync(phaseDir);
    const plans = files.filter(f => f.endsWith('-PLAN.md') || f === 'PLAN.md');
    const summaries = files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');
    return { total: plans.length, complete: summaries.length };
  } catch {
    return { total: 0, complete: 0 };
  }
}

// =============================================================================
// Phase Directory Discovery
// =============================================================================

/**
 * Normalize a phase number for directory matching.
 * "1" -> "01", "2.1" -> "02.1"
 */
function normalizePhaseName(phase: number): string {
  const str = String(phase);
  const parts = str.split('.');
  const padded = parts[0]!.padStart(2, '0');
  return parts.length > 1 ? `${padded}.${parts[1]}` : padded;
}

/**
 * Find the phase directory on disk matching a phase number.
 * Looks for directories matching pattern `{paddedNum}-*` in .planning/phases/.
 * Returns the full directory path, or null if not found.
 */
function findPhaseDir(phasesDir: string, phaseNumber: number): string | null {
  try {
    if (!fs.existsSync(phasesDir)) return null;

    const prefix = normalizePhaseName(phaseNumber) + '-';
    const entries = fs.readdirSync(phasesDir);

    for (const entry of entries) {
      if (entry.startsWith(prefix)) {
        const fullPath = path.join(phasesDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) return fullPath;
        } catch {
          // Skip unreadable entries
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// readGsdState (main entry point)
// =============================================================================

/**
 * Read the complete GSD state from a project's .planning/ directory.
 *
 * This is the single entry point for all downstream GSD integration.
 * Never throws -- returns EMPTY_GSD_STATE on any error.
 *
 * @param projectDir - The project root directory (contains .planning/)
 * @returns Typed GsdState with position, phases, and cross-reference warnings
 */
export function readGsdState(projectDir: string): GsdState {
  try {
    const planningDir = path.join(projectDir, '.planning');
    if (!fs.existsSync(planningDir)) {
      return EMPTY_GSD_STATE;
    }

    // Parse STATE.md
    let position: GsdCurrentPosition | null = null;
    const statePath = path.join(planningDir, 'STATE.md');
    if (fs.existsSync(statePath)) {
      try {
        const stateContent = fs.readFileSync(statePath, 'utf-8');
        position = parseStateMd(stateContent);
      } catch (e) {
        log.warn('Failed to read STATE.md', e);
      }
    }

    // Parse ROADMAP.md
    let phases: GsdPhase[] = [];
    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    if (fs.existsSync(roadmapPath)) {
      try {
        const roadmapContent = fs.readFileSync(roadmapPath, 'utf-8');
        phases = parseRoadmapMd(roadmapContent);
      } catch (e) {
        log.warn('Failed to read ROADMAP.md', e);
      }
    }

    // If neither STATE.md nor ROADMAP.md produced useful data, not active
    if (!position && phases.length === 0) {
      return EMPTY_GSD_STATE;
    }

    // Enrich phases with plan counts from disk
    const phasesDir = path.join(planningDir, 'phases');
    for (const phase of phases) {
      const phaseDir = findPhaseDir(phasesDir, phase.number);
      if (phaseDir) {
        phase.plans = countPlanFiles(phaseDir);
      }
      // else: phase.plans remains null (synthetic entry -- no directory on disk)
    }

    // Cross-reference warnings
    const warnings = buildCrossReferenceWarnings(position, phases, phasesDir);

    return {
      active: true,
      position,
      phases,
      warnings,
    };
  } catch (e) {
    log.error('Failed to read GSD state', e);
    return EMPTY_GSD_STATE;
  }
}

// =============================================================================
// Cross-Reference Warnings
// =============================================================================

/**
 * Build cross-reference warnings between STATE.md and filesystem state.
 */
function buildCrossReferenceWarnings(
  position: GsdCurrentPosition | null,
  phases: GsdPhase[],
  phasesDir: string,
): string[] {
  const warnings: string[] = [];

  // Warning: phases beyond current have plan files on disk
  if (position) {
    for (const phase of phases) {
      if (phase.number > position.phase && phase.plans && phase.plans.total > 0) {
        warnings.push(
          `STATE.md says Phase ${position.phase} but Phase ${phase.number} (${phase.name}) has ${phase.plans.total} plan file(s) on disk`,
        );
      }
    }
  }

  // Warning: disk directories not in ROADMAP.md
  try {
    if (fs.existsSync(phasesDir)) {
      const phaseNumbers = new Set(phases.map(p => normalizePhaseName(p.number)));
      const diskEntries = fs.readdirSync(phasesDir);

      for (const entry of diskEntries) {
        try {
          const fullPath = path.join(phasesDir, entry);
          const stat = fs.statSync(fullPath);
          if (!stat.isDirectory()) continue;

          // Extract the phase number prefix from directory name
          const prefixMatch = entry.match(/^(\d+(?:\.\d+)?)-/);
          if (prefixMatch) {
            const dirPhaseNum = prefixMatch[1]!;
            // Normalize to match (e.g., "99" -> "99", "01" -> "01")
            const normalized = dirPhaseNum.replace(/^0+(\d)/, '$1');
            const normalizedPadded = normalized.split('.').map((p, i) =>
              i === 0 ? p.padStart(2, '0') : p,
            ).join('.');

            if (!phaseNumbers.has(normalizedPadded)) {
              warnings.push(
                `Phase directory "${entry}" exists on disk but is not in ROADMAP.md`,
              );
            }
          }
        } catch {
          // Skip unreadable entries
        }
      }
    }
  } catch {
    // Ignore errors scanning disk
  }

  return warnings;
}
