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
import type { PostToolUseInput } from '../shared/types.js';

const HOOK_NAME = 'post-tool-use';

runHook(HOOK_NAME, async (input) => {
  const postInput = input as PostToolUseInput;
  const sessionId = postInput.session_id || 'unknown';
  const cwd = postInput.cwd || process.cwd();
  const toolName = postInput.tool_name || '';
  const toolInput = postInput.tool_input || {};
  const toolResponse = postInput.tool_response;

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

  // Step 3: Store in SQLite
  try {
    const { getDatabase } = await import('../db/connection.js');
    const { storeObservation } = await import('../db/observations.js');
    const { incrementObservationCount } = await import('../db/sessions.js');

    const db = getDatabase();
    try {
      const result = storeObservation(db, observation);
      if (result.id !== -1) {
        incrementObservationCount(db, sessionId);
        logToFile(HOOK_NAME, 'DEBUG', `Observation stored (id=${result.id}) tool=${toolName}`);
      } else {
        logToFile(HOOK_NAME, 'WARN', `storeObservation returned error sentinel for tool=${toolName}`);
      }
    } finally {
      db.close();
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'SQLite unavailable, skipping storage (Tier 2 degradation)', err);
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
