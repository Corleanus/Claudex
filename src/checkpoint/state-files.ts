/**
 * Claudex v3 -- Incremental State I/O
 *
 * Session-scoped YAML files that accumulate decisions, questions,
 * file touches, and thread state during a session. The checkpoint
 * writer bundles these at 80% utilization.
 *
 * All paths: {projectDir}/context/state/{sessionId}/
 *
 * Never throws -- returns empty arrays/objects on read failure.
 * Uses sync fs operations (matching all other Claudex shared modules).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { ensureEpochMs } from '../shared/epoch.js';
import type { Decision, FileState, ThreadState } from './types.js';

const log = createLogger('state-files');

// =============================================================================
// Internal Helpers
// =============================================================================

/** Get the state directory for a session */
function stateDir(projectDir: string, sessionId: string): string {
  return path.join(projectDir, 'context', 'state', sessionId);
}

/** Ensure a directory exists (create if missing) */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Strip UTF-8 BOM and normalize CRLF before YAML parsing.
 * Handles all Windows line ending variants.
 */
function normalizeYaml(raw: string): string {
  // Strip BOM (U+FEFF) — appears at start of UTF-8 files on Windows
  let content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  // Normalize CRLF → LF
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return content;
}

/**
 * Safely parse a YAML file. Returns null on any error (corrupt, missing, empty).
 * Uses JSON_SCHEMA to prevent type coercion (e.g., 'yes' → true).
 */
function safeLoadYaml(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const normalized = normalizeYaml(raw);
    return yaml.load(normalized, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    log.warn(`Failed to parse YAML: ${filePath}`, e);
    return null;
  }
}

/**
 * Safely write a YAML file. Creates parent directories if needed.
 * Uses JSON_SCHEMA for consistent serialization.
 */
function safeWriteYaml(filePath: string, data: unknown): void {
  try {
    ensureDir(path.dirname(filePath));
    const content = yaml.dump(data, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,        // No line wrapping
      noRefs: true,         // No YAML anchors/aliases
      sortKeys: false,      // Preserve insertion order
    });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch (e) {
    log.error(`Failed to write YAML: ${filePath}`, e);
  }
}

// =============================================================================
// Decisions
// =============================================================================

/**
 * Read all decisions for a session.
 * Returns empty array if file is missing or corrupt.
 */
export function readDecisions(projectDir: string, sessionId: string): Decision[] {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'decisions.yaml');
    const data = safeLoadYaml(filePath);
    if (!Array.isArray(data)) return [];
    return data as Decision[];
  } catch (e) {
    log.error('readDecisions failed', e);
    return [];
  } finally {
    recordMetric('state_read_decisions', Date.now() - t0);
  }
}

/**
 * Append a decision to the session's decisions file.
 * Creates the file if it doesn't exist.
 */
export function appendDecision(projectDir: string, sessionId: string, decision: Decision): void {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'decisions.yaml');
    const existing = readDecisions(projectDir, sessionId);
    existing.push(decision);
    safeWriteYaml(filePath, existing);
  } catch (e) {
    log.error('appendDecision failed', e);
  } finally {
    recordMetric('state_write_decisions', Date.now() - t0);
  }
}

// =============================================================================
// Open Questions
// =============================================================================

/**
 * Read all open questions for a session.
 * Returns empty array if file is missing or corrupt.
 */
export function readQuestions(projectDir: string, sessionId: string): string[] {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'questions.yaml');
    const data = safeLoadYaml(filePath);
    if (!Array.isArray(data)) return [];
    return data as string[];
  } catch (e) {
    log.error('readQuestions failed', e);
    return [];
  } finally {
    recordMetric('state_read_questions', Date.now() - t0);
  }
}

/**
 * Append a question to the session's questions file.
 * Creates the file if it doesn't exist.
 */
export function appendQuestion(projectDir: string, sessionId: string, question: string): void {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'questions.yaml');
    const existing = readQuestions(projectDir, sessionId);
    existing.push(question);
    safeWriteYaml(filePath, existing);
  } catch (e) {
    log.error('appendQuestion failed', e);
  } finally {
    recordMetric('state_write_questions', Date.now() - t0);
  }
}

// =============================================================================
// Files Touched
// =============================================================================

/** Create a fresh empty FileState (avoids shared-reference mutation) */
function emptyFileState(): FileState {
  return { changed: [], read: [], hot: [] };
}

/**
 * Read the files-touched state for a session.
 * Returns empty FileState if file is missing or corrupt.
 */
export function readFilesTouched(projectDir: string, sessionId: string): FileState {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'files-touched.yaml');
    const data = safeLoadYaml(filePath);
    if (!data || typeof data !== 'object') return emptyFileState();
    const obj = data as Record<string, unknown>;
    return {
      changed: Array.isArray(obj.changed) ? obj.changed as FileState['changed'] : [],
      read: Array.isArray(obj.read) ? obj.read as string[] : [],
      hot: Array.isArray(obj.hot) ? obj.hot as string[] : [],
    };
  } catch (e) {
    log.error('readFilesTouched failed', e);
    return emptyFileState();
  } finally {
    recordMetric('state_read_files', Date.now() - t0);
  }
}

/**
 * Record a file touch in the session's files-touched state.
 * Accumulates across multiple calls.
 */
export function recordFileTouch(
  projectDir: string,
  sessionId: string,
  filePath: string,
  action: string,
  summary: string,
): void {
  const t0 = Date.now();
  try {
    const yamlPath = path.join(stateDir(projectDir, sessionId), 'files-touched.yaml');
    const existing = readFilesTouched(projectDir, sessionId);

    // Add to changed list
    existing.changed.push({ path: filePath, action, summary });

    // Track in hot list (deduplicated)
    if (!existing.hot.includes(filePath)) {
      existing.hot.push(filePath);
    }

    safeWriteYaml(yamlPath, existing);
  } catch (e) {
    log.error('recordFileTouch failed', e);
  } finally {
    recordMetric('state_write_files', Date.now() - t0);
  }
}

// =============================================================================
// Thread
// =============================================================================

/** Create a fresh empty ThreadState (avoids shared-reference mutation) */
function emptyThreadState(): ThreadState {
  return { summary: '', key_exchanges: [] };
}

/**
 * Read the thread state for a session.
 * Returns empty ThreadState if file is missing or corrupt.
 */
export function readThread(projectDir: string, sessionId: string): ThreadState {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'thread.yaml');
    const data = safeLoadYaml(filePath);
    if (!data || typeof data !== 'object') return emptyThreadState();
    const obj = data as Record<string, unknown>;
    return {
      summary: typeof obj.summary === 'string' ? obj.summary : '',
      key_exchanges: Array.isArray(obj.key_exchanges)
        ? obj.key_exchanges as ThreadState['key_exchanges']
        : [],
    };
  } catch (e) {
    log.error('readThread failed', e);
    return emptyThreadState();
  } finally {
    recordMetric('state_read_thread', Date.now() - t0);
  }
}

/**
 * Append an exchange to the session's thread state.
 */
export function appendExchange(
  projectDir: string,
  sessionId: string,
  exchange: { role: 'user' | 'agent'; gist: string },
): void {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'thread.yaml');
    const existing = readThread(projectDir, sessionId);
    existing.key_exchanges.push(exchange);
    safeWriteYaml(filePath, existing);
  } catch (e) {
    log.error('appendExchange failed', e);
  } finally {
    recordMetric('state_write_thread', Date.now() - t0);
  }
}

/**
 * Update the thread summary (overwrites, doesn't append).
 */
export function updateThreadSummary(projectDir: string, sessionId: string, summary: string): void {
  const t0 = Date.now();
  try {
    const filePath = path.join(stateDir(projectDir, sessionId), 'thread.yaml');
    const existing = readThread(projectDir, sessionId);
    existing.summary = summary;
    safeWriteYaml(filePath, existing);
  } catch (e) {
    log.error('updateThreadSummary failed', e);
  } finally {
    recordMetric('state_write_thread_summary', Date.now() - t0);
  }
}

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Archive state files for a session after checkpoint write.
 * Renames (NOT deletes): state/{sessionId}/ -> state/archived/{checkpointId}/
 */
export function archiveStateFiles(
  projectDir: string,
  sessionId: string,
  checkpointId: string,
): void {
  const t0 = Date.now();
  try {
    const srcDir = stateDir(projectDir, sessionId);
    if (!fs.existsSync(srcDir)) return;

    const archiveDir = path.join(projectDir, 'context', 'state', 'archived', checkpointId);
    ensureDir(path.dirname(archiveDir));
    fs.renameSync(srcDir, archiveDir);
  } catch (e) {
    log.error('archiveStateFiles failed', e);
  } finally {
    recordMetric('state_archive', Date.now() - t0);
  }
}

/**
 * Clean up archived state directories older than maxAge (in milliseconds).
 * Removes archived dirs where the directory mtime is older than maxAge.
 */
export function cleanupOldArchives(projectDir: string, maxAge: number): void {
  const t0 = Date.now();
  try {
    const archiveRoot = path.join(projectDir, 'context', 'state', 'archived');
    if (!fs.existsSync(archiveRoot)) return;

    const now = ensureEpochMs(Date.now());
    const entries = fs.readdirSync(archiveRoot);

    for (const entry of entries) {
      try {
        const entryPath = path.join(archiveRoot, entry);
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;

        const ageMs = now - ensureEpochMs(stat.mtimeMs);
        if (ageMs > maxAge) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch (e) {
        log.warn(`Failed to clean archive entry: ${entry}`, e);
      }
    }
  } catch (e) {
    log.error('cleanupOldArchives failed', e);
  } finally {
    recordMetric('state_cleanup', Date.now() - t0);
  }
}
