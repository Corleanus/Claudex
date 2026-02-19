/**
 * Claudex v2 — Flat File Mirror
 *
 * Mirrors SQLite data to human-readable markdown files.
 * The human is never locked out of their own data: SQLite is the machine
 * interface, markdown files are the human interface.
 *
 * Observations are append-only. Pressure scores overwrite (single snapshot).
 * Never crashes the caller.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { CLAUDEX_HOME, dailyMemoryPath } from '../shared/paths.js';
import type {
  ConsensusDecision,
  Observation,
  PressureScore,
  ReasoningChain,
  Scope,
  TemperatureLevel,
} from '../shared/types.js';

/**
 * Mirror an observation to the appropriate daily markdown file.
 *
 * - Global scope → ~/.claudex/memory/daily/YYYY-MM-DD.md
 * - Project scope → <project_path>/context/observations/YYYY-MM-DD.md
 *
 * Append-only. Creates directories and files as needed.
 * Never throws — logs errors to stderr and continues.
 */
export function mirrorObservation(obs: Observation, scope: Scope): void {
  try {
    const filePath = resolveTargetPath(obs, scope);
    const entry = formatEntry(obs);

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, entry, 'utf-8');
  } catch (err) {
    console.error('[claudex] flat-file-mirror: write failed:', err);
  }
}

/**
 * Resolve the target daily markdown file path based on scope.
 */
function resolveTargetPath(obs: Observation, scope: Scope): string {
  const dateStr = obs.timestamp.split('T')[0]!;

  if (scope.type === 'global') {
    return dailyMemoryPath(dateStr);
  }

  // Project scope: <project_path>/context/observations/YYYY-MM-DD.md
  return path.join(scope.path, 'context', 'observations', `${dateStr}.md`);
}

/**
 * Format an observation as a markdown entry.
 */
function formatEntry(obs: Observation): string {
  const time = formatTime(obs.timestamp);
  const files = formatFiles(obs.files_read, obs.files_modified);

  let entry = `### ${time} — ${obs.title}\n\n`;
  entry += `**Category**: ${obs.category} | **Importance**: ${obs.importance}/5\n\n`;
  entry += `${obs.content}\n\n`;

  if (files) {
    entry += `**Files**: ${files}\n\n`;
  }

  entry += `---\n\n`;
  return entry;
}

/**
 * Extract HH:MM (24-hour, local time) from an ISO-8601 timestamp.
 */
function formatTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Format files_read and files_modified into a single comma-separated string.
 */
function formatFiles(
  filesRead: string[] | undefined,
  filesModified: string[] | undefined,
): string {
  const parts: string[] = [];

  if (filesRead && filesRead.length > 0) {
    parts.push(...filesRead);
  }
  if (filesModified && filesModified.length > 0) {
    parts.push(...filesModified);
  }

  return parts.join(', ');
}

// =============================================================================
// Filename sanitizer
// =============================================================================

/**
 * Replace non-filesystem-safe characters with hyphens and truncate to 50 chars.
 */
export function sanitizeFilename(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9_\-. ]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// =============================================================================
// Reasoning chain mirror
// =============================================================================

/**
 * Mirror a reasoning chain to a markdown file.
 *
 * - Global scope → ~/.claudex/reasoning/<session_id>/<timestamp>-<sanitized_title>.md
 * - Project scope → <project_path>/context/reasoning/<session_id>/<timestamp>-<sanitized_title>.md
 *
 * Never throws — logs errors to stderr and continues.
 */
export function mirrorReasoning(chain: ReasoningChain, scope: Scope): void {
  try {
    const ts = chain.timestamp
      .replace(/:/g, '-')
      .replace('.', '-')
      .replace('Z', '');
    const filename = `${ts}-${sanitizeFilename(chain.title)}.md`;

    const dir =
      scope.type === 'global'
        ? path.join(CLAUDEX_HOME, 'reasoning', chain.session_id)
        : path.join(scope.path, 'context', 'reasoning', chain.session_id);

    const filePath = path.join(dir, filename);

    const decisions =
      chain.decisions && chain.decisions.length > 0
        ? chain.decisions.map(d => `- ${d}`).join('\n')
        : 'None recorded';

    const files =
      chain.files_involved && chain.files_involved.length > 0
        ? chain.files_involved.map(f => `- ${f}`).join('\n')
        : 'None recorded';

    const content = [
      `# ${chain.title}`,
      '',
      `- **Trigger:** ${chain.trigger}`,
      `- **Session:** ${chain.session_id}`,
      `- **Time:** ${chain.timestamp}`,
      `- **Importance:** ${chain.importance}/5`,
      '',
      '## Reasoning',
      '',
      chain.reasoning,
      '',
      '## Decisions',
      '',
      decisions,
      '',
      '## Files Involved',
      '',
      files,
      '',
    ].join('\n');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.error('[claudex] flat-file-mirror: reasoning write failed:', err);
  }
}

// =============================================================================
// Consensus decision mirror
// =============================================================================

/**
 * Mirror a consensus decision to a markdown file.
 *
 * - Global scope → ~/.claudex/consensus/<session_id>/<timestamp>-<sanitized_title>.md
 * - Project scope → <project_path>/context/consensus/<session_id>/<timestamp>-<sanitized_title>.md
 *
 * Never throws — logs errors to stderr and continues.
 */
export function mirrorConsensus(decision: ConsensusDecision, scope: Scope): void {
  try {
    const ts = decision.timestamp
      .replace(/:/g, '-')
      .replace('.', '-')
      .replace('Z', '');
    const filename = `${ts}-${sanitizeFilename(decision.title)}.md`;

    const dir =
      scope.type === 'global'
        ? path.join(CLAUDEX_HOME, 'consensus', decision.session_id)
        : path.join(scope.path, 'context', 'consensus', decision.session_id);

    const filePath = path.join(dir, filename);

    const tags =
      decision.tags && decision.tags.length > 0
        ? decision.tags.join(', ')
        : 'None';

    const files =
      decision.files_affected && decision.files_affected.length > 0
        ? decision.files_affected.map(f => `- ${f}`).join('\n')
        : 'None';

    const content = [
      `# ${decision.title}`,
      '',
      `- **Status:** ${decision.status}`,
      `- **Session:** ${decision.session_id}`,
      `- **Time:** ${decision.timestamp}`,
      `- **Importance:** ${decision.importance}/5`,
      '',
      '## Description',
      '',
      decision.description,
      '',
      '## Positions',
      '',
      `**Claude:** ${decision.claude_position || 'Not recorded'}`,
      `**Codex:** ${decision.codex_position || 'Not recorded'}`,
      `**Human verdict:** ${decision.human_verdict || 'Not recorded'}`,
      '',
      '## Tags',
      '',
      tags,
      '',
      '## Files Affected',
      '',
      files,
      '',
    ].join('\n');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.error('[claudex] flat-file-mirror: consensus write failed:', err);
  }
}

// =============================================================================
// Pressure scores mirror
// =============================================================================

/**
 * Mirror pressure scores to a single markdown snapshot file.
 *
 * - Global scope → ~/.claudex/pressure/scores.md
 * - Project scope → <project_path>/context/pressure/scores.md
 *
 * Overwrites the file each time (snapshot, not append-only).
 * Never throws — logs errors to stderr and continues.
 */
export function mirrorPressureScores(scores: PressureScore[], scope: Scope): void {
  try {
    const dir =
      scope.type === 'global'
        ? path.join(CLAUDEX_HOME, 'pressure')
        : path.join(scope.path, 'context', 'pressure');

    const filePath = path.join(dir, 'scores.md');

    const now = new Date().toISOString();

    const grouped: Record<TemperatureLevel, PressureScore[]> = {
      HOT: [],
      WARM: [],
      COLD: [],
    };

    for (const s of scores) {
      grouped[s.temperature].push(s);
    }

    function buildTable(level: TemperatureLevel): string {
      const rows = grouped[level];
      let section = `## ${level} Files\n`;
      section += '| File | Pressure | Decay Rate |\n';
      section += '|------|----------|------------|\n';
      for (const r of rows) {
        section += `| ${r.file_path} | ${r.raw_pressure.toFixed(3)} | ${r.decay_rate.toFixed(3)} |\n`;
      }
      return section;
    }

    const content = [
      '# Pressure Scores',
      '',
      `Updated: ${now}`,
      '',
      buildTable('HOT'),
      '',
      buildTable('WARM'),
      '',
      buildTable('COLD'),
      '',
    ].join('\n');

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (err) {
    console.error('[claudex] flat-file-mirror: pressure write failed:', err);
  }
}
