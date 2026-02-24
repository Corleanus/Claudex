/**
 * Claudex v2 -- Cross-Phase Writer
 *
 * Detects recurring file patterns across completed phase SUMMARY.md files
 * and extracts decision history from session logs and handoffs. Writes
 * `.planning/context/CROSS-PHASE.md` for GSD agent consumption.
 *
 * Never throws -- returns empty/false on any error (Claudex convention).
 * Uses sync file operations (matching flat-file-mirror.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../shared/logger.js';
import type { RecurringPattern, PhaseDecision } from './types.js';

const log = createLogger('gsd-cross-phase-writer');

// =============================================================================
// Constants
// =============================================================================

/** Minimum time between CROSS-PHASE.md rewrites (5 minutes) */
const DEBOUNCE_MS = 5 * 60 * 1000;

// =============================================================================
// Regex Patterns
// =============================================================================

const FM_PATTERN = /^---\n([\s\S]*?)\n---/;
const HANDOFF_ID_PATTERN = /^handoff_id:\s*(.+)$/m;
const PHASE_FROM_HANDOFF = /gsd-phase(\d+)/;
const DECISIONS_SECTION = /## Decisions Made\n([\s\S]*?)(?=\n## |\n---|$)/;
const HANDOFF_DECISIONS_SECTION = /## (?:Design )?Decisions(?: Made)?(?:\s*\([^)]*\))?\n([\s\S]*?)(?=\n## |\n---|$)/i;
const SESSION_FILENAME = /(\d{4}-\d{2}-\d{2})_session-/;

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Extract key-files (created and modified) from a plan SUMMARY.md's YAML frontmatter.
 */
function extractKeyFiles(content: string): { created: string[]; modified: string[] } {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(FM_PATTERN);
  if (!fmMatch) return { created: [], modified: [] };

  const frontmatter = fmMatch[1]!;

  // Parse key-files.created
  const createdMatch = frontmatter.match(/key-files:\s*\n\s+created:\s*\n((?:\s+- .+\n?)*)/);
  const created = createdMatch
    ? createdMatch[1]!.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
    : [];

  // Parse key-files.modified
  const modifiedMatch = frontmatter.match(/modified:\s*\n((?:\s+- .+\n?)*)/);
  const modified = modifiedMatch
    ? modifiedMatch[1]!.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim())
    : [];

  return { created, modified };
}

/**
 * Extract the plan title from the markdown body (first `# ` heading after frontmatter).
 */
function extractPlanTitle(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  // Skip frontmatter, find first # heading
  const bodyStart = normalized.match(/^---\n[\s\S]*?\n---\n/);
  const body = bodyStart ? normalized.slice(bodyStart[0].length) : normalized;
  const headingMatch = body.match(/^#\s+(.+)$/m);
  return headingMatch ? headingMatch[1]!.trim() : 'unknown plan';
}

/**
 * Extract the phase label from YAML frontmatter `phase:` field.
 */
function extractPhaseLabel(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(FM_PATTERN);
  if (!fmMatch) return 'unknown';
  const phaseMatch = fmMatch[1]!.match(/^phase:\s*(.+)$/m);
  return phaseMatch ? phaseMatch[1]!.trim() : 'unknown';
}

/**
 * Map a handoff_id to a phase label for grouping decisions.
 */
function mapHandoffIdToPhaseLabel(handoffId: string | null): string {
  if (!handoffId || handoffId === 'null' || handoffId === 'active') {
    return 'General';
  }

  const phaseMatch = handoffId.match(PHASE_FROM_HANDOFF);
  if (phaseMatch) {
    return `Phase ${phaseMatch[1]}`;
  }

  if (handoffId.includes('gsd-integration') || handoffId.includes('integration')) {
    return 'GSD Integration';
  }

  // Other patterns (phase10, handoff-3, handoff-6, etc.)
  return 'Claudex v2 Internal';
}

/**
 * Parse decision lines from a section body.
 * Handles both plain `- text` and `- **Key**: value` formats.
 */
function parseDecisionLines(sectionContent: string): string[] {
  return sectionContent
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('- '))
    .map(l => {
      let text = l.slice(2).trim();
      // Handle **Key**: value format -> "Key: value"
      const boldMatch = text.match(/^\*\*([^*]+)\*\*:\s*(.+)/);
      if (boldMatch) {
        text = `${boldMatch[1]}: ${boldMatch[2]}`;
      }
      return text;
    })
    .filter(Boolean);
}

/**
 * Sort phase labels: Phase N before Phase M (numeric), then alphabetic.
 */
function phaseSort(a: string, b: string): number {
  const aNum = a.match(/Phase (\d+)/);
  const bNum = b.match(/Phase (\d+)/);

  if (aNum && bNum) {
    return parseInt(aNum[1]!, 10) - parseInt(bNum[1]!, 10);
  }
  if (aNum) return -1;
  if (bNum) return 1;

  // Non-phase labels: GSD Integration before Claudex v2 Internal before General
  const order: Record<string, number> = {
    'GSD Integration': 0,
    'Claudex v2 Internal': 1,
    'General': 2,
  };
  const aOrder = order[a] ?? 99;
  const bOrder = order[b] ?? 99;
  if (aOrder !== bOrder) return aOrder - bOrder;
  return a.localeCompare(b);
}

// =============================================================================
// detectRecurringPatterns
// =============================================================================

/**
 * Detect files that appear in key-files across 2+ completed phase SUMMARY.md
 * files. Returns patterns sorted by number of appearances (most first).
 *
 * @param projectDir - Project root (contains .planning/)
 */
export function detectRecurringPatterns(projectDir: string): RecurringPattern[] {
  try {
    const phasesDir = path.join(projectDir, '.planning', 'phases');
    if (!fs.existsSync(phasesDir)) return [];

    // Map: filePath -> Array<{phase, reason}>
    const fileMap = new Map<string, Array<{ phase: string; reason: string }>>();

    const phaseDirs = fs.readdirSync(phasesDir);
    for (const phaseEntry of phaseDirs) {
      const phaseFullPath = path.join(phasesDir, phaseEntry);
      try {
        const stat = fs.statSync(phaseFullPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      // Find all *-SUMMARY.md files in this phase directory
      const files = fs.readdirSync(phaseFullPath);
      const summaryFiles = files.filter(f => f.endsWith('-SUMMARY.md') || f === 'SUMMARY.md');

      for (const summaryFile of summaryFiles) {
        try {
          const summaryPath = path.join(phaseFullPath, summaryFile);
          const content = fs.readFileSync(summaryPath, 'utf-8');

          const phaseLabel = extractPhaseLabel(content);
          const title = extractPlanTitle(content);
          const keyFiles = extractKeyFiles(content);

          for (const filePath of keyFiles.created) {
            if (!fileMap.has(filePath)) fileMap.set(filePath, []);
            fileMap.get(filePath)!.push({
              phase: phaseLabel,
              reason: `created (${title})`,
            });
          }

          for (const filePath of keyFiles.modified) {
            if (!fileMap.has(filePath)) fileMap.set(filePath, []);
            fileMap.get(filePath)!.push({
              phase: phaseLabel,
              reason: `modified (${title})`,
            });
          }
        } catch {
          // Skip unreadable summary files
        }
      }
    }

    // Filter to 2+ appearances, convert to RecurringPattern[], sort by count desc
    const patterns: RecurringPattern[] = [];
    for (const [filePath, appearances] of fileMap) {
      if (appearances.length >= 2) {
        patterns.push({ filePath, appearances });
      }
    }

    patterns.sort((a, b) => b.appearances.length - a.appearances.length);

    return patterns;
  } catch (e) {
    log.warn('Failed to detect recurring patterns', e);
    return [];
  }
}

// =============================================================================
// extractDecisionHistory
// =============================================================================

/**
 * Extract decisions from session logs and handoffs, attributed to phases
 * via handoff_id frontmatter.
 *
 * @param claudexDir - Claudex directory (contains context/sessions/, context/handoffs/)
 */
export function extractDecisionHistory(claudexDir: string): Map<string, PhaseDecision[]> {
  try {
    const result = new Map<string, PhaseDecision[]>();

    // --- Session Logs ---
    const sessionsDir = path.join(claudexDir, 'context', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const sessionFiles = fs.readdirSync(sessionsDir)
        .filter(f => f.endsWith('.md'))
        .sort(); // Chronological by filename

      for (const sessionFile of sessionFiles) {
        try {
          const sessionPath = path.join(sessionsDir, sessionFile);
          const content = fs.readFileSync(sessionPath, 'utf-8').replace(/\r\n/g, '\n');

          // Extract handoff_id
          const fmMatch = content.match(FM_PATTERN);
          const handoffMatch = fmMatch?.[1]?.match(HANDOFF_ID_PATTERN);
          const handoffId = handoffMatch?.[1]?.trim() ?? null;

          // Extract decisions
          const decisionsMatch = content.match(DECISIONS_SECTION);
          if (!decisionsMatch) continue;

          const decisions = parseDecisionLines(decisionsMatch[1]!);
          if (decisions.length === 0) continue;

          // Date from filename
          const dateMatch = sessionFile.match(SESSION_FILENAME);
          const date = dateMatch?.[1] ?? 'unknown';

          // Phase label
          const phaseLabel = mapHandoffIdToPhaseLabel(handoffId);

          // Add to result
          if (!result.has(phaseLabel)) result.set(phaseLabel, []);
          for (const decision of decisions) {
            result.get(phaseLabel)!.push({
              date,
              decision,
              source: 'session',
            });
          }
        } catch {
          // Skip unreadable session files
        }
      }
    }

    // --- Handoff Files ---
    const handoffsDir = path.join(claudexDir, 'context', 'handoffs');
    if (fs.existsSync(handoffsDir)) {
      const handoffFiles: string[] = [];

      // ACTIVE.md
      const activePath = path.join(handoffsDir, 'ACTIVE.md');
      if (fs.existsSync(activePath)) handoffFiles.push(activePath);

      // Archive
      const archiveDir = path.join(handoffsDir, 'archive');
      if (fs.existsSync(archiveDir)) {
        const archiveEntries = fs.readdirSync(archiveDir)
          .filter(f => f.endsWith('.md'))
          .sort();
        for (const entry of archiveEntries) {
          handoffFiles.push(path.join(archiveDir, entry));
        }
      }

      for (const handoffPath of handoffFiles) {
        try {
          const content = fs.readFileSync(handoffPath, 'utf-8').replace(/\r\n/g, '\n');

          // Extract handoff_id
          const fmMatch = content.match(FM_PATTERN);
          const handoffMatch = fmMatch?.[1]?.match(HANDOFF_ID_PATTERN);
          const handoffId = handoffMatch?.[1]?.trim() ?? null;

          // Extract decisions with flexible heading
          const decisionsMatch = content.match(HANDOFF_DECISIONS_SECTION);
          if (!decisionsMatch) continue;

          const decisions = parseDecisionLines(decisionsMatch[1]!);
          if (decisions.length === 0) continue;

          // Date from created_at in frontmatter if available
          const dateMatch = fmMatch?.[1]?.match(/^created_at:\s*(\d{4}-\d{2}-\d{2})/m);
          const date = dateMatch?.[1] ?? 'unknown';

          // Phase label
          const phaseLabel = mapHandoffIdToPhaseLabel(handoffId);

          // Add to result
          if (!result.has(phaseLabel)) result.set(phaseLabel, []);
          for (const decision of decisions) {
            result.get(phaseLabel)!.push({
              date,
              decision,
              source: 'handoff',
            });
          }
        } catch {
          // Skip unreadable handoff files
        }
      }
    }

    // Sort decisions within each phase by date
    for (const [, decisions] of result) {
      decisions.sort((a, b) => a.date.localeCompare(b.date));
    }

    // Return as a sorted Map (phase order)
    const sortedKeys = Array.from(result.keys()).sort(phaseSort);
    const sorted = new Map<string, PhaseDecision[]>();
    for (const key of sortedKeys) {
      sorted.set(key, result.get(key)!);
    }

    return sorted;
  } catch (e) {
    log.warn('Failed to extract decision history', e);
    return new Map();
  }
}

// =============================================================================
// writeCrossPhaseSummary
// =============================================================================

/**
 * Generate and write `.planning/context/CROSS-PHASE.md` with recurring
 * file patterns and decision history sections.
 *
 * Returns true if written, false if skipped (debounce, empty data, error).
 *
 * @param projectDir - Project root (contains .planning/)
 * @param claudexDir - Claudex directory (contains context/sessions/)
 */
export function writeCrossPhaseSummary(projectDir: string, claudexDir: string): boolean {
  try {
    const contextDir = path.join(projectDir, '.planning', 'context');
    const outputPath = path.join(contextDir, 'CROSS-PHASE.md');

    // Debounce gate: skip if file is fresh (< 5 min old)
    try {
      const stat = fs.statSync(outputPath);
      if (Date.now() - stat.mtimeMs < DEBOUNCE_MS) return false;
    } catch {
      // File doesn't exist -- proceed to write
    }

    // Collect data
    const patterns = detectRecurringPatterns(projectDir);
    const decisionsByPhase = extractDecisionHistory(claudexDir);

    // If both empty, nothing to write
    if (patterns.length === 0 && decisionsByPhase.size === 0) return false;

    // Format markdown
    const timestamp = new Date().toISOString();

    let content = '# Cross-Phase Intelligence\n\n';
    content += `**Updated:** ${timestamp}\n\n`;

    // Section 1: Recurring File Patterns
    content += '## Recurring File Patterns\n\n';
    if (patterns.length === 0) {
      content += '_No recurring patterns detected across completed phases._\n\n';
    } else {
      for (const pattern of patterns) {
        content += `### \`${pattern.filePath}\`\n`;
        for (const { phase, reason } of pattern.appearances) {
          content += `- **${phase}**: ${reason}\n`;
        }
        content += '\n';
      }
    }

    // Section 2: Decision History
    content += '## Decision History\n\n';
    if (decisionsByPhase.size === 0) {
      content += '_No decisions extracted from session logs or handoffs._\n\n';
    } else {
      for (const [phaseLabel, decisions] of decisionsByPhase) {
        content += `### ${phaseLabel}\n`;
        for (const { date, decision } of decisions) {
          content += `- (${date}) ${decision}\n`;
        }
        content += '\n';
      }
    }

    // Ensure directory exists and write
    fs.mkdirSync(contextDir, { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');

    return true;
  } catch (e) {
    log.warn('Failed to write cross-phase summary', e);
    return false;
  }
}
