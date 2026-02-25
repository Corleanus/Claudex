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
import { recordFileTouch } from '../checkpoint/state-files.js';
import { PATHS } from '../shared/paths.js';
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

  // Step 3.7: Update incremental state (files-touched for checkpoint system)
  if (observation.files_modified && observation.files_modified.length > 0) {
    try {
      const projectDir = scope.type === 'project' ? scope.path : PATHS.home;
      for (const filePath of observation.files_modified) {
        recordFileTouch(projectDir, sessionId, filePath, toolName, observation.title);
      }
      logToFile(HOOK_NAME, 'DEBUG', `State: recorded ${observation.files_modified.length} file touches`);
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'State file update failed (non-fatal)', err);
    }
  }

  // Close DB after Steps 3 + 3.5
  if (db) {
    try { db.close(); } catch { /* best effort */ }
  }

  // Step 4: REMOVED — flat-file observation mirror killed.
  // DB is the authoritative store with decay, FTS5, and selection pressure.
  // Daily files are now curated-only (written by /endsession Step 5).

  // Step 4.5. Thread accumulation — capture agent action (rolling window: max 20)
  if (observation && scope.type === 'project') {
    try {
      const { appendExchange, readThread } = await import('../checkpoint/state-files.js');
      const projectDir = scope.path;

      const thread = readThread(projectDir, sessionId);
      if (thread.key_exchanges.length >= 20) {
        // Rolling window: trim to last 14, then append new exchange
        const trimmed = thread.key_exchanges.slice(-14);
        const actionGist = `${toolName}: ${observation.title}`.slice(0, 100);
        trimmed.push({ role: 'agent', gist: actionGist });

        // Rewrite thread.yaml with trimmed exchanges
        const fsSync = await import('node:fs');
        const pathMod = await import('node:path');
        const yamlMod = await import('js-yaml');
        const threadPath = pathMod.join(projectDir, 'context', 'state', sessionId, 'thread.yaml');
        const newThread = { summary: thread.summary, key_exchanges: trimmed };
        const content = yamlMod.dump(newThread, { schema: yamlMod.JSON_SCHEMA, lineWidth: -1, noRefs: true, sortKeys: false });
        fsSync.writeFileSync(threadPath, content, 'utf-8');
      } else {
        const actionGist = `${toolName}: ${observation.title}`.slice(0, 100);
        appendExchange(projectDir, sessionId, { role: 'agent', gist: actionGist });
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'DEBUG', 'Thread accumulation failed (non-fatal)', err);
    }
  }

  return {};
});
