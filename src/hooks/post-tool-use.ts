/**
 * Claudex v2 — PostToolUse Hook (WP-14)
 *
 * Fires after every tool use. Extracts structured observations from
 * tool I/O and stores them in SQLite. Does NOT inject context —
 * always returns empty {}.
 *
 * NEVER throws — exits 0 always. Each step has independent error handling.
 */

import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { extractObservation } from '../lib/observation-extractor.js';
import { loadConfig } from '../shared/config.js';
import type { PostToolUseInput } from '../shared/types.js';

const HOOK_NAME = 'post-tool-use';

runHook(HOOK_NAME, async (input) => {
  const postInput = input as PostToolUseInput;
  const sessionId = postInput.session_id || 'unknown';
  const cwd = postInput.cwd || process.cwd();
  const toolName = postInput.tool_name || '';
  const toolInput = postInput.tool_input || {};
  const toolResponse = postInput.tool_response;

  // Gate: skip observation capture when explicitly disabled in config
  const config = loadConfig();
  if (config.observation?.enabled === false) {
    logToFile(HOOK_NAME, 'DEBUG', 'Observation capture disabled by config');
    return {};
  }

  // Step 1: Detect scope
  const scope = detectScope(cwd);

  // Step 2: Extract observation (returns null for filtered/trivial tools)
  let observation;
  try {
    observation = extractObservation(toolName, toolInput, toolResponse, sessionId, scope);
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Observation extraction failed', err);
    return {};
  }

  if (!observation) {
    return {};
  }

  // Acquire DB once for Steps 3 + 3.5, close after both complete
  let db: import('better-sqlite3').Database | null = null;
  try {
    const { getDatabase } = await import('../db/connection.js');
    db = getDatabase();
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'SQLite unavailable, skipping storage (Tier 2 degradation)', err);
  }

  // Step 3: Store in SQLite
  if (!db) {
    logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping observation storage (Tier 2 degradation)');
  } else {
    try {
      const { storeObservation } = await import('../db/observations.js');
      const { incrementObservationCount } = await import('../db/sessions.js');

      const result = storeObservation(db, observation);
      if (result.id !== -1) {
        incrementObservationCount(db, sessionId);
        logToFile(HOOK_NAME, 'DEBUG', `Observation stored (id=${result.id}) tool=${toolName}`);
      } else {
        logToFile(HOOK_NAME, 'WARN', `storeObservation returned error sentinel for tool=${toolName}`);
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', 'Observation storage failed (non-fatal)', err);
    }
  }

  // Step 3.5: Accumulate local pressure scores from file observations
  if (observation && db) {
    try {
      const { accumulatePressureScore } = await import('../db/pressure.js');
      const project = scope.type === 'project' ? scope.name : undefined;

      // Tool-weighted increments — only accumulate for known file-bearing tools
      const TOOL_INCREMENTS: Record<string, number> = {
        Write: 0.15, Edit: 0.15,  // mutative = high signal
        Read: 0.05,               // discovery = medium signal
        Grep: 0.02,               // search hit = low signal
      };

      const increment = TOOL_INCREMENTS[toolName];
      if (increment !== undefined) {
        // Accumulate for all touched files (dedupe: same file in both modified + read)
        const allFiles = [...new Set([
          ...(observation.files_modified || []),
          ...(observation.files_read || []),
        ])];

        for (const filePath of allFiles) {
          accumulatePressureScore(db, filePath, project, increment);
        }

        if (allFiles.length > 0) {
          logToFile(HOOK_NAME, 'DEBUG', `Accumulated pressure for ${allFiles.length} files (tool=${toolName}, increment=${increment})`);
        }
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'Pressure accumulation failed (non-fatal)', err);
    }
  }

  // Close DB after Steps 3 + 3.5
  if (db) {
    try { db.close(); } catch { /* best effort */ }
  }

  // Step 4: Mirror to flat file (WP-17 soft dependency — skip if unavailable)
  try {
    const { mirrorObservation } = await import('../lib/flat-file-mirror.js');
    mirrorObservation(observation, scope);
  } catch {
    // WP-17 not ready or mirror failed — non-blocking, skip silently
  }

  return {};
});
