/**
 * Claudex v2 — Path Constants
 *
 * All paths to Claudex runtime files. Uses path.join() for cross-platform support.
 * Never hardcode / or \ — always use these constants.
 */

import * as path from 'node:path';
import * as os from 'node:os';

/** ~/.claudex/ — Claudex global root */
export const CLAUDEX_HOME = path.join(os.homedir(), '.claudex');

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
  return path.join(PATHS.transcripts, sessionId);
}

/**
 * Get the completion marker path for a session.
 */
export function completionMarkerPath(sessionId: string): string {
  return path.join(PATHS.sessions, `.completed-${sessionId}`);
}

/**
 * Get the session log path (global scope).
 */
export function globalSessionLogPath(sessionId: string): string {
  return path.join(PATHS.sessions, `${sessionId}.md`);
}
