/**
 * Claudex v2 — Observation Extractor (WP-15)
 *
 * Transforms raw tool I/O into compact, structured Observation objects.
 * Applied in PostToolUse hook to build the observation stream.
 */

import type { Observation, ObservationCategory, Scope } from '../shared/types.js';
import { redactSensitive, sanitizePath } from './redaction.js';

// Backward-compatible alias: existing imports of redactSecrets keep working
export { redactSensitive as redactSecrets } from './redaction.js';

// =============================================================================
// Helpers
// =============================================================================

const TRIVIAL_BASH_COMMANDS = new Set(['ls', 'cd', 'pwd']);

function str(val: unknown): string {
  if (typeof val === 'string') return val;
  if (val == null) return '';
  return String(val);
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

function fileExtension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
}

function summarizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '...';
}

function baseCommand(command: string): string {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] || trimmed;
  // Strip path prefixes
  return basename(first);
}

function makeObservation(
  sessionId: string,
  scope: Scope,
  toolName: string,
  category: ObservationCategory,
  title: string,
  content: string,
  importance: number,
  filesRead?: string[],
  filesModified?: string[],
): Observation {
  const now = new Date();
  const projectRoot = scope.type === 'project' ? scope.path : undefined;

  // Sanitize file paths to remove usernames/PII
  const sanitizedFilesRead = filesRead?.map(f => sanitizePath(f, projectRoot));
  const sanitizedFilesModified = filesModified?.map(f => sanitizePath(f, projectRoot));

  return {
    session_id: sessionId,
    timestamp: now.toISOString(),
    timestamp_epoch: now.getTime(),
    tool_name: toolName,
    category,
    title: redactSensitive(title),
    content: redactSensitive(content),
    files_read: sanitizedFilesRead,
    files_modified: sanitizedFilesModified,
    importance,
    project: scope.type === 'project' ? scope.name : undefined,
  };
}

// =============================================================================
// Per-tool Extractors
// =============================================================================

function extractRead(
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const filePath = str(toolInput['file_path'] || toolInput['path']);
  if (!filePath) return null;

  const ext = fileExtension(filePath);
  const fileType = ext ? ext.toUpperCase() : 'unknown';

  let contentSummary = `File type: ${fileType}`;
  if (toolResponse) {
    const output = str(toolResponse['output'] || toolResponse['content'] || '');
    if (output) {
      const preview = truncateLines(output, 3);
      contentSummary += `\n${preview}`;
    }
  }

  return makeObservation(
    sessionId,
    scope,
    'Read',
    'discovery',
    `Read: ${basename(filePath)}`,
    contentSummary,
    2,
    [filePath],
  );
}

function extractEdit(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const filePath = str(toolInput['file_path'] || toolInput['path']);
  if (!filePath) return null;

  const oldStr = str(toolInput['old_string']);
  const newStr = str(toolInput['new_string']);

  const oldSummary = oldStr
    ? truncateLines(oldStr, 2)
    : '(unknown)';
  const newSummary = newStr
    ? truncateLines(newStr, 2)
    : '(unknown)';

  const content = `Old: ${oldSummary}\nNew: ${newSummary}`;

  return makeObservation(
    sessionId,
    scope,
    'Edit',
    'change',
    `Edit: ${basename(filePath)}`,
    content,
    3,
    undefined,
    [filePath],
  );
}

function extractWrite(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const filePath = str(toolInput['file_path'] || toolInput['path']);
  if (!filePath) return null;

  const ext = fileExtension(filePath);
  const name = basename(filePath);
  const content = `Created ${name}${ext ? ` (${ext.toUpperCase()})` : ''}`;

  return makeObservation(
    sessionId,
    scope,
    'Write',
    'feature',
    `Write: ${basename(filePath)}`,
    content,
    3,
    undefined,
    [filePath],
  );
}

function extractBash(
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const command = str(toolInput['command']);
  if (!command) return null;

  // Filter trivial commands
  const base = baseCommand(command);
  if (TRIVIAL_BASH_COMMANDS.has(base)) return null;

  const exitCode = toolResponse != null ? (toolResponse['exit_code'] ?? toolResponse['exitCode']) : undefined;
  const isError = exitCode != null && exitCode !== 0;

  let content = '';
  if (exitCode != null) {
    content += `Exit code: ${exitCode}`;
  }

  if (toolResponse) {
    const output = str(toolResponse['output'] || toolResponse['stdout'] || '');
    if (output) {
      const preview = truncateLines(output, 5);
      content += content ? '\n' : '';
      content += preview;
    }
    const stderr = str(toolResponse['stderr'] || '');
    if (stderr && isError) {
      const errPreview = truncateLines(stderr, 3);
      content += content ? '\n' : '';
      content += `stderr: ${errPreview}`;
    }
  }

  if (!content) {
    content = `Ran: ${summarizeCommand(command)}`;
  }

  return makeObservation(
    sessionId,
    scope,
    'Bash',
    isError ? 'error' : 'change',
    `Run: ${summarizeCommand(command)}`,
    content,
    isError ? 4 : 3,
  );
}

function extractGrep(
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const pattern = str(toolInput['pattern']);
  if (!pattern) return null;

  let matchCount = 0;
  let topFiles: string[] = [];

  if (toolResponse) {
    const files = toolResponse['files'] || toolResponse['matches'] || toolResponse['output'];
    if (Array.isArray(files)) {
      matchCount = files.length;
      topFiles = files.slice(0, 5).map((f) => str(typeof f === 'object' && f != null ? (f as Record<string, unknown>)['path'] || f : f));
    } else if (typeof files === 'string') {
      const lines = files.split('\n').filter(Boolean);
      matchCount = lines.length;
      // Strip :line:content suffixes from grep output lines (e.g. "src/foo.ts:10:matched")
      topFiles = lines.slice(0, 5).map(line => line.split(':')[0] || line);
    }
  }

  const content = `Pattern: ${pattern}\nMatches: ${matchCount}${topFiles.length > 0 ? '\nTop files: ' + topFiles.join(', ') : ''}`;

  const filesRead = topFiles.length > 0 ? topFiles : undefined;

  return makeObservation(
    sessionId,
    scope,
    'Grep',
    'discovery',
    `Search: ${pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern}`,
    content,
    2,
    filesRead,
  );
}

function extractGlob(
  _toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
): boolean {
  // Glob is filtered out unless it has >= 3 results
  if (!toolResponse) return false;

  const files = toolResponse['files'] || toolResponse['matches'] || toolResponse['output'];
  if (Array.isArray(files)) return files.length >= 3;
  if (typeof files === 'string') {
    return files.split('\n').filter(Boolean).length >= 3;
  }
  return false;
}

function extractWebFetch(
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const url = str(toolInput['url']);
  if (!url) return null;

  let summary = `URL: ${url}`;
  if (toolResponse) {
    const status = toolResponse['status'] || toolResponse['statusCode'];
    if (status != null) {
      summary += `\nStatus: ${status}`;
    }
    const body = str(toolResponse['output'] || toolResponse['content'] || toolResponse['body'] || '');
    if (body) {
      summary += '\n' + truncateLines(body, 3);
    }
  }

  return makeObservation(
    sessionId,
    scope,
    'WebFetch',
    'discovery',
    `Fetch: ${url.length > 50 ? url.slice(0, 47) + '...' : url}`,
    summary,
    3,
  );
}

// =============================================================================
// Main Entry Point
// =============================================================================

const HANDLED_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch']);

export function extractObservation(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  if (!HANDLED_TOOLS.has(toolName)) return null;

  switch (toolName) {
    case 'Read':
      return extractRead(toolInput, toolResponse, sessionId, scope);

    case 'Edit':
      return extractEdit(toolInput, toolResponse, sessionId, scope);

    case 'Write':
      return extractWrite(toolInput, toolResponse, sessionId, scope);

    case 'Bash':
      return extractBash(toolInput, toolResponse, sessionId, scope);

    case 'Grep':
      return extractGrep(toolInput, toolResponse, sessionId, scope);

    case 'Glob':
      // Glob is filtered out if < 3 results — return null in that case
      // For Glob with >= 3 results, we treat it like a discovery
      if (!extractGlob(toolInput, toolResponse)) return null;
      {
        const pattern = str(toolInput['pattern']);
        return makeObservation(
          sessionId,
          scope,
          'Glob',
          'discovery',
          `Glob: ${pattern.length > 40 ? pattern.slice(0, 37) + '...' : pattern}`,
          `Pattern: ${pattern}`,
          2,
        );
      }

    case 'WebFetch':
      return extractWebFetch(toolInput, toolResponse, sessionId, scope);

    default:
      return null;
  }
}
