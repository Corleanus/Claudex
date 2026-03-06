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

/** Minimum raw output length for a Read to be worth storing. */
const MIN_READ_CONTENT_LENGTH = 100;

const TRIVIAL_BASH_COMMANDS = new Set([
  'ls', 'cd', 'pwd', 'cat', 'head', 'tail', 'echo',
  'type', 'dir', 'cls', 'clear', 'which', 'where', 'whoami',
]);

function coerceString(val: unknown): string {
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
  const filePath = coerceString(toolInput['file_path'] || toolInput['path']);
  if (!filePath) return null;

  // Fast-path: skip trivial reads before expensive string processing
  const rawOutput = toolResponse
    ? coerceString(toolResponse['output'] || toolResponse['content'] || '')
    : '';
  if (!rawOutput || rawOutput.length < MIN_READ_CONTENT_LENGTH) return null;

  const ext = fileExtension(filePath);
  const fileType = ext ? ext.toUpperCase() : 'unknown';

  let contentSummary = `File type: ${fileType}`;
  const preview = truncateLines(rawOutput, 8);
  contentSummary += `\n${preview}`;

  // Secondary filter: formatted content can be shorter than raw after truncation
  if (contentSummary.length < MIN_READ_CONTENT_LENGTH) return null;

  // Dynamic importance: config/test files get 3, others get 2
  const readExt = fileExtension(filePath).toLowerCase();
  const readBase = basename(filePath).toLowerCase();
  const isConfigFile = ['json', 'yaml', 'yml', 'toml', 'env', 'md'].includes(readExt)
    || readBase === '.env' || readBase.startsWith('.env.');
  const isTestFile = readBase.endsWith('.test.ts') || readBase.endsWith('.spec.ts');
  const readImportance = (isConfigFile || isTestFile) ? 3 : 2;

  return makeObservation(
    sessionId,
    scope,
    'Read',
    'discovery',
    `Read: ${basename(filePath)}`,
    contentSummary,
    readImportance,
    [filePath],
  );
}

function extractEdit(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const filePath = coerceString(toolInput['file_path'] || toolInput['path']);
  if (!filePath) return null;

  const oldStr = coerceString(toolInput['old_string']);
  const newStr = coerceString(toolInput['new_string']);

  const oldSummary = oldStr
    ? truncateLines(oldStr, 5)
    : '(unknown)';
  const newSummary = newStr
    ? truncateLines(newStr, 5)
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
  const filePath = coerceString(toolInput['file_path'] || toolInput['path']);
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
  const command = coerceString(toolInput['command']);
  if (!command) return null;

  // Filter trivial commands
  const base = baseCommand(command);
  if (TRIVIAL_BASH_COMMANDS.has(base)) return null;

  const description = coerceString(toolInput['description']);
  const exitCode = toolResponse != null ? (toolResponse['exit_code'] ?? toolResponse['exitCode']) : undefined;
  const isError = exitCode != null && exitCode !== 0;

  let content = '';
  if (description) {
    content += `[${description}] `;
  }
  if (exitCode != null) {
    content += `Exit code: ${exitCode}`;
  }

  if (toolResponse) {
    const output = coerceString(toolResponse['output'] || toolResponse['stdout'] || '');
    if (output) {
      const preview = truncateLines(output, 10);
      content += content ? '\n' : '';
      content += preview;
    }
    const stderr = coerceString(toolResponse['stderr'] || '');
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

/**
 * Parse file path from a grep output line, handling Windows drive-letter paths,
 * UNC paths, and Unix paths. Falls back to returning the full line.
 */
function parseGrepFilePath(line: string): string {
  // Windows drive-letter paths: C:\repo\file.ts:10:match or C:/repo/file.ts:10:match
  const winDrive = line.match(/^([A-Za-z]:[\\\/][^:]*):\d+:/);
  if (winDrive) return winDrive[1]!;

  // Windows UNC paths: \\server\share\file.ts:10:match
  const winUnc = line.match(/^(\\\\[^:]+):\d+:/);
  if (winUnc) return winUnc[1]!;

  // Unix-style paths: src/foo.ts:10:match
  const unix = line.match(/^([^:]+):\d+:/);
  if (unix) return unix[1]!;

  // No colon-delimited structure — return as-is
  return line;
}

function extractGrep(
  toolInput: Record<string, unknown>,
  toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const pattern = coerceString(toolInput['pattern']);
  if (!pattern) return null;

  let matchCount = 0;
  let topFiles: string[] = [];

  if (toolResponse) {
    const files = toolResponse['files'] || toolResponse['matches'] || toolResponse['output'];
    if (Array.isArray(files)) {
      matchCount = files.length;
      topFiles = files.slice(0, 5).map((f) => coerceString(typeof f === 'object' && f != null ? (f as Record<string, unknown>)['path'] || f : f));
    } else if (typeof files === 'string') {
      const lines = files.split('\n').filter(Boolean);
      matchCount = lines.length;
      topFiles = lines.slice(0, 5).map(parseGrepFilePath);
    }
  }

  // Filter zero-match greps — they're noise in the observation DB
  if (matchCount === 0) return null;

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
  const url = coerceString(toolInput['url']);
  if (!url) return null;

  let summary = `URL: ${url}`;
  if (toolResponse) {
    const status = toolResponse['status'] || toolResponse['statusCode'];
    if (status != null) {
      summary += `\nStatus: ${status}`;
    }
    const body = coerceString(toolResponse['output'] || toolResponse['content'] || toolResponse['body'] || '');
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

function extractTask(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const prompt = coerceString(toolInput['prompt']);
  if (!prompt) return null;

  const subagentType = coerceString(toolInput['subagent_type'] || 'general');
  const promptSummary = prompt.length > 100 ? prompt.slice(0, 97) + '...' : prompt;
  const content = `Task (${subagentType}): ${promptSummary}`;

  return makeObservation(
    sessionId,
    scope,
    'Task',
    'change',
    `Task: ${promptSummary.length > 40 ? promptSummary.slice(0, 37) + '...' : promptSummary}`,
    content,
    3,
  );
}

function extractWebSearch(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const query = coerceString(toolInput['query']);
  if (!query) return null;

  const content = `WebSearch: ${query}`;

  return makeObservation(
    sessionId,
    scope,
    'WebSearch',
    'discovery',
    `Search: ${query.length > 40 ? query.slice(0, 37) + '...' : query}`,
    content,
    3,
  );
}

function extractNotebookEdit(
  toolInput: Record<string, unknown>,
  _toolResponse: Record<string, unknown> | undefined,
  sessionId: string,
  scope: Scope,
): Observation | null {
  const notebookPath = coerceString(toolInput['notebook_path']);
  if (!notebookPath) return null;

  const newSource = coerceString(toolInput['new_source']);
  const preview = newSource ? truncateLines(newSource, 5) : '(empty)';
  const content = `NotebookEdit ${basename(notebookPath)}: ${preview}`;

  return makeObservation(
    sessionId,
    scope,
    'NotebookEdit',
    'change',
    `NotebookEdit: ${basename(notebookPath)}`,
    content,
    3,
    undefined,
    [notebookPath],
  );
}

// =============================================================================
// Main Entry Point
// =============================================================================

const HANDLED_TOOLS = new Set([
  'Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch',
  'Task', 'WebSearch', 'NotebookEdit',
]);

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
        const pattern = coerceString(toolInput['pattern']);
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

    case 'Task':
      return extractTask(toolInput, toolResponse, sessionId, scope);

    case 'WebSearch':
      return extractWebSearch(toolInput, toolResponse, sessionId, scope);

    case 'NotebookEdit':
      return extractNotebookEdit(toolInput, toolResponse, sessionId, scope);

    default:
      return null;
  }
}
