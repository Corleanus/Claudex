/**
 * Claudex v2 — Path Constants
 *
 * All paths to Claudex runtime files. Uses path.join() for cross-platform support.
 * Never hardcode / or \ — always use these constants.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** ~/.claudex/ — Claudex global root */
export const CLAUDEX_HOME = path.join(os.homedir(), '.claudex');

/**
 * Sanitize session_id to prevent path traversal attacks.
 * Strips path separators and limits to alphanumeric, hyphens, and underscores.
 * @param sessionId - Raw session_id from input
 * @returns Sanitized session_id safe for filesystem paths
 */
function sanitizeSessionId(sessionId: string): string {
  // Remove path separators and limit to safe characters
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
}

/** All Claudex runtime paths */
export const PATHS = {
  // Root
  home: CLAUDEX_HOME,

  // Identity
  identity: path.join(CLAUDEX_HOME, 'identity'),
  agentMd: path.join(CLAUDEX_HOME, 'identity', 'AGENT.md'),
  userMd: path.join(CLAUDEX_HOME, 'identity', 'USER.md'),
  bootstrapMd: path.join(CLAUDEX_HOME, 'identity', 'BOOTSTRAP.md'),

  // Memory
  memory: path.join(CLAUDEX_HOME, 'memory'),
  memoryIndex: path.join(CLAUDEX_HOME, 'memory', 'MEMORY.md'),
  memoryDaily: path.join(CLAUDEX_HOME, 'memory', 'daily'),
  memoryTopics: path.join(CLAUDEX_HOME, 'memory', 'topics'),

  // Sessions
  sessions: path.join(CLAUDEX_HOME, 'sessions'),
  sessionIndex: path.join(CLAUDEX_HOME, 'sessions', 'index.json'),

  // Transcripts
  transcripts: path.join(CLAUDEX_HOME, 'transcripts'),

  // Hooks
  hooks: path.join(CLAUDEX_HOME, 'hooks'),
  hookLogs: path.join(CLAUDEX_HOME, 'hooks', 'logs'),

  // Database (NEW in Phase 1)
  db: path.join(CLAUDEX_HOME, 'db'),
  database: path.join(CLAUDEX_HOME, 'db', 'claudex.db'),
  hologramPort: path.join(CLAUDEX_HOME, 'db', 'hologram.port'),
  hologramPid: path.join(CLAUDEX_HOME, 'db', 'hologram.pid'),

  // Configuration
  config: path.join(CLAUDEX_HOME, 'config.json'),
  projects: path.join(CLAUDEX_HOME, 'projects.json'),
} as const;

/**
 * Get the daily memory file path for a given date.
 * @param date - Date string in YYYY-MM-DD format, or Date object
 */
export function dailyMemoryPath(date: string | Date): string {
  const dateStr = date instanceof Date
    ? date.toISOString().split('T')[0]!
    : date;
  return path.join(PATHS.memoryDaily, `${dateStr}.md`);
}

/**
 * Get the transcript directory for a session.
 */
export function transcriptDir(sessionId: string): string {
  return path.join(PATHS.transcripts, sanitizeSessionId(sessionId));
}

/**
 * Get the completion marker path for a session.
 */
export function completionMarkerPath(sessionId: string): string {
  return path.join(PATHS.sessions, `.completed-${sanitizeSessionId(sessionId)}`);
}

/**
 * Get the session log path (global scope).
 */
export function globalSessionLogPath(sessionId: string): string {
  return path.join(PATHS.sessions, `${sanitizeSessionId(sessionId)}.md`);
}

/**
 * Get the session directory path.
 */
export function sessionDir(sessionId: string): string {
  return path.join(PATHS.sessions, sanitizeSessionId(sessionId));
}

/**
 * Find an existing session log file by matching session_id in YAML frontmatter.
 *
 * Search order:
 * 1. Scan .md files in the sessions directory for YAML frontmatter with matching session_id
 * 2. Fall back to date-pattern matching (YYYY-MM-DD_session-N.md)
 * 3. Return null if nothing found
 *
 * @param sessionId - The session_id to match
 * @param sessionsDir - The directory to scan (project context/sessions/ or ~/.claudex/sessions/)
 * @returns Absolute path to the matching session log, or null
 */
export function findCurrentSessionLog(sessionId: string, sessionsDir: string): string | null {
  try {
    if (!fs.existsSync(sessionsDir)) return null;

    const entries = fs.readdirSync(sessionsDir);
    const mdFiles = entries.filter(e => e.endsWith('.md'));

    // Pass 1: Check YAML frontmatter for session_id match
    for (const file of mdFiles) {
      const filePath = path.join(sessionsDir, file);
      try {
        // Read only the first 512 bytes — frontmatter is always at the top
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(512);
        const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
        fs.closeSync(fd);

        const head = buf.toString('utf-8', 0, bytesRead);
        // Match YAML frontmatter: starts with ---, has session_id: <id>, ends with ---
        const fmMatch = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fmMatch) {
          const fm = fmMatch[1]!;
          const sidMatch = fm.match(/^session_id:\s*(.+)$/m);
          if (sidMatch && sidMatch[1]!.trim() === sessionId) {
            return filePath;
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    // Pass 2: Date pattern fallback — look for today's date pattern
    const today = new Date().toISOString().split('T')[0]!; // YYYY-MM-DD
    const datePattern = new RegExp(`^${today.replace(/-/g, '-')}_session-\\d+\\.md$`);
    for (const file of mdFiles) {
      if (datePattern.test(file)) {
        return path.join(sessionsDir, file);
      }
    }

    // Pass 3: Also check subdirectories (session-end writes to sessions/<session_id>/summary.md)
    const safeId = sanitizeSessionId(sessionId);
    const subDir = path.join(sessionsDir, safeId);
    if (fs.existsSync(subDir)) {
      const summaryPath = path.join(subDir, 'summary.md');
      if (fs.existsSync(summaryPath)) {
        return summaryPath;
      }
    }

    return null;
  } catch {
    return null;
  }
}
