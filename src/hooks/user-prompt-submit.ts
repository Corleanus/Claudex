/**
 * Claudex v2 — UserPromptSubmit Hook (WP-13)
 *
 * Fires on every user prompt. Queries the hologram sidecar for
 * pressure-scored context, queries FTS5 for relevant observations,
 * and injects assembled context into Claude's input via additionalContext.
 *
 * NEVER throws — exits 0 always. Each subsystem has independent error handling.
 * Short prompts (< 10 chars) skip heavy injection entirely.
 */

import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { loadConfig } from '../shared/config.js';
import { assembleContext } from '../lib/context-assembler.js';
import type { UserPromptSubmitInput, HologramResponse, SearchResult, Observation, Scope } from '../shared/types.js';

const HOOK_NAME = 'user-prompt-submit';
const SHORT_PROMPT_THRESHOLD = 10;
const CONTEXT_TOKEN_BUDGET = 4000;

// =============================================================================
// Subsystem queries (each independently try/caught)
// =============================================================================

/**
 * Query the hologram sidecar for pressure-scored file context.
 * Uses ResilientHologramClient for automatic retry + recency fallback.
 * Returns null if hologram is disabled or entirely unavailable.
 */
async function queryHologram(
  promptText: string,
  sessionId: string,
  recentFiles: string[],
): Promise<HologramResponse | null> {
  try {
    const config = loadConfig();

    if (config.hologram?.enabled === false) {
      logToFile(HOOK_NAME, 'DEBUG', 'Hologram disabled in config, skipping');
      return null;
    }

    const { SidecarManager } = await import('../hologram/launcher.js');
    const { ProtocolHandler } = await import('../hologram/protocol.js');
    const { HologramClient } = await import('../hologram/client.js');
    const { ResilientHologramClient } = await import('../hologram/degradation.js');

    const launcher = new SidecarManager();
    const protocol = new ProtocolHandler(config.hologram?.timeout_ms ?? 2000);
    const client = new HologramClient(launcher, protocol, config);
    const resilient = new ResilientHologramClient(client, config);

    const result = await resilient.queryWithFallback(promptText, 0, sessionId, recentFiles);

    logToFile(HOOK_NAME, 'DEBUG', `Hologram query complete, source=${result.source}`);
    return result;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Hologram query failed entirely', err);
    return null;
  }
}

/**
 * Extract unique file paths from recent observations for recency fallback.
 * Collects files_read and files_modified, deduplicates, returns up to 10.
 */
function extractRecentFiles(observations: Observation[]): string[] {
  const seen = new Set<string>();
  for (const obs of observations) {
    if (obs.files_modified) {
      for (const f of obs.files_modified) seen.add(f);
    }
    if (obs.files_read) {
      for (const f of obs.files_read) seen.add(f);
    }
  }
  return [...seen].slice(0, 10);
}

/**
 * Extract simple keywords from a prompt for FTS5 search.
 * Filters out short words and common stop words.
 */
function extractKeywords(prompt: string): string {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
    'that', 'it', 'not', 'but', 'and', 'or', 'if', 'then', 'so',
    'what', 'which', 'who', 'how', 'when', 'where', 'why',
    'all', 'each', 'every', 'any', 'no', 'some', 'just', 'also',
    'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
    'please', 'thanks', 'thank',
  ]);

  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  // Deduplicate and take top 5 keywords
  const unique = [...new Set(words)].slice(0, 5);
  return unique.join(' ');
}

/**
 * Query FTS5 search for observations matching prompt keywords.
 * Returns empty array if database is unavailable or query fails.
 */
function queryFts5(promptText: string, scope: Scope): SearchResult[] {
  try {
    const keywords = extractKeywords(promptText);
    if (!keywords) {
      logToFile(HOOK_NAME, 'DEBUG', 'No keywords extracted from prompt, skipping FTS5');
      return [];
    }

    const { getDatabase } = require('../db/connection.js') as typeof import('../db/connection.js');
    const { searchObservations } = require('../db/search.js') as typeof import('../db/search.js');

    const db = getDatabase();
    try {
      const project = scope.type === 'project' ? scope.name : undefined;
      const results = searchObservations(db, keywords, {
        project,
        limit: 5,
        minImportance: 2,
      });
      logToFile(HOOK_NAME, 'DEBUG', `FTS5 search returned ${results.length} results for "${keywords}"`);
      return results;
    } finally {
      db.close();
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'FTS5 search failed, skipping', err);
    return [];
  }
}

/**
 * Get recent observations as fallback context.
 * Returns empty array if database is unavailable.
 */
function getRecent(scope: Scope): Observation[] {
  try {
    const { getDatabase } = require('../db/connection.js') as typeof import('../db/connection.js');
    const { getRecentObservations } = require('../db/observations.js') as typeof import('../db/observations.js');

    const db = getDatabase();
    try {
      const project = scope.type === 'project' ? scope.name : undefined;
      const recent = getRecentObservations(db, 5, project);
      logToFile(HOOK_NAME, 'DEBUG', `Got ${recent.length} recent observations`);
      return recent;
    } finally {
      db.close();
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Recent observations query failed, skipping', err);
    return [];
  }
}

// =============================================================================
// Main hook
// =============================================================================

runHook(HOOK_NAME, async (input) => {
  const startMs = Date.now();
  const promptInput = input as UserPromptSubmitInput;
  const sessionId = promptInput.session_id || 'unknown';
  const cwd = promptInput.cwd || process.cwd();

  // 1. Extract prompt text (field name may vary across Claude Code versions)
  const inputAny = input as unknown as Record<string, unknown>;
  const promptText = (inputAny.prompt as string)
    || (inputAny.user_message as string)
    || '';

  // 2. Short prompt check — skip heavy injection for trivial prompts
  if (typeof promptText === 'string' && promptText.length < SHORT_PROMPT_THRESHOLD) {
    logToFile(HOOK_NAME, 'DEBUG', `Short prompt (${promptText.length} chars), skipping injection`);
    return {};
  }

  // 3. Detect scope
  const scope = detectScope(cwd);
  logToFile(HOOK_NAME, 'DEBUG', `Scope: ${scope.type === 'project' ? `project:${scope.name}` : 'global'}`);

  // 4. Get recent observations early — needed for both context AND hologram fallback
  const recentObservations = getRecent(scope);

  // 5. Query hologram sidecar (with degradation fallback using recent file paths)
  const recentFiles = extractRecentFiles(recentObservations);
  const hologramResult = await queryHologram(promptText, sessionId, recentFiles);

  // 6. Query FTS5 search (keywords from prompt)
  const ftsResults = queryFts5(promptText, scope);

  // 7. Assemble context
  const assembled = assembleContext(
    {
      hologram: hologramResult,
      searchResults: ftsResults,
      recentObservations,
      scope,
    },
    { maxTokens: CONTEXT_TOKEN_BUDGET },
  );

  const elapsedMs = Date.now() - startMs;
  logToFile(HOOK_NAME, 'INFO', `Completed in ${elapsedMs}ms, tokens=${assembled.tokenEstimate}, sources=[${assembled.sources.join(',')}]`);

  // 8. Return — empty if nothing assembled
  if (!assembled.markdown) {
    return {};
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: assembled.markdown,
    },
  };
});
