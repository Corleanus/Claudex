/**
 * Claudex v2 — Flat File Mirror
 *
 * Mirrors SQLite observations to human-readable markdown files.
 * The human is never locked out of their own data: SQLite is the machine
 * interface, markdown files are the human interface.
 *
 * Append-only. Never overwrites. Never crashes the caller.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { dailyMemoryPath } from '../shared/paths.js';
import type { Observation, Scope } from '../shared/types.js';

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
