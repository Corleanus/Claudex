/**
 * Claudex v2 — Prompt Query Helpers
 *
 * Subsystem queries for the UserPromptSubmit hook. Each function is
 * independently try/caught and returns null/empty on failure.
 *
 * Extracted from user-prompt-submit.ts to keep the main hook file focused
 * on orchestration.
 */

import { logToFile } from './_infrastructure.js';
import { loadConfig } from '../shared/config.js';
import { normalizeFts5Query } from '../shared/fts5-utils.js';
import { SidecarManager } from '../hologram/launcher.js';
import { ProtocolHandler } from '../hologram/protocol.js';
import { HologramClient } from '../hologram/client.js';
import { ResilientHologramClient } from '../hologram/degradation.js';
import { searchAll } from '../db/search.js';
import { getRecentObservations } from '../db/observations.js';
import type { SearchResult, Observation, Scope, ClaudexConfig } from '../shared/types.js';
import type { ContextSuggestion } from '../hologram/degradation.js';

const HOOK_NAME = 'user-prompt-submit';

/** Stop words filtered out during keyword extraction. Module-scope to avoid re-creation per call. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'this',
  'that', 'it', 'not', 'but', 'and', 'or', 'if', 'then', 'so',
  'what', 'which', 'who', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'any', 'no', 'some', 'just', 'also',
  'me', 'my', 'we', 'our', 'you', 'your', 'they', 'them', 'their',
  'please', 'thanks', 'thank',
  // Technical stop words — noise in a code-centric memory system
  'file', 'code', 'function', 'const', 'let', 'var', 'import', 'export',
  'return', 'true', 'false', 'null', 'undefined', 'new', 'class', 'type',
  'interface',
]);

/**
 * Query the hologram sidecar for pressure-scored file context.
 * Uses ResilientHologramClient for automatic retry + recency fallback.
 * Returns null if hologram is disabled or entirely unavailable.
 *
 * @param db - Shared database handle for fallback tier (caller manages lifecycle)
 * @param config - Pre-loaded config (avoids redundant loadConfig() calls)
 */
export async function queryHologram(
  promptText: string,
  sessionId: string,
  recentFiles: string[],
  scope: Scope,
  db: import('better-sqlite3').Database | null,
  boostFiles?: string[],
  config?: ClaudexConfig,
): Promise<ContextSuggestion | null> {
  try {
    const cfg = config ?? loadConfig();

    if (cfg.hologram?.enabled === false) {
      logToFile(HOOK_NAME, 'DEBUG', 'Hologram disabled in config, skipping');
      return null;
    }

    const launcher = new SidecarManager();
    const protocol = new ProtocolHandler(cfg.hologram?.timeout_ms ?? 2000);
    const client = new HologramClient(launcher, protocol, cfg);
    const resilient = new ResilientHologramClient(client, cfg);

    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'DB unavailable for fallback tier, continuing without');
    }

    const project = scope.type === 'project' ? scope.name : undefined;
    const projectDir = scope.type === 'project' ? scope.path : undefined;
    const result = await resilient.queryWithFallback(promptText, 0, sessionId, recentFiles, db ?? undefined, project, projectDir, boostFiles);

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
export function extractRecentFiles(observations: Observation[]): string[] {
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
export function extractKeywords(prompt: string): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top 8 keywords (more = better recall with OR-expansion)
  const unique = [...new Set(words)].slice(0, 8);
  const keywords = unique.join(' ');

  // Normalize for FTS5 (strips hyphens and other special chars)
  return normalizeFts5Query(keywords);
}

/**
 * Query FTS5 search across all tables (observations, reasoning, consensus).
 * Uses strict-then-relax strategy: AND first, OR fallback if < 2 results.
 * Applies temporal re-ranking to boost recent results.
 * Returns empty array if database is unavailable or query fails.
 *
 * @param db - Shared database handle (caller manages lifecycle)
 */
export async function queryFts5(promptText: string, scope: Scope, db: import('better-sqlite3').Database | null): Promise<SearchResult[]> {
  try {
    const keywords = extractKeywords(promptText);
    if (!keywords) {
      logToFile(HOOK_NAME, 'DEBUG', 'No keywords extracted from prompt, skipping FTS5');
      return [];
    }

    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database unavailable, skipping FTS5');
      return [];
    }

    const project = scope.type === 'project' ? scope.name : undefined;

    // Strict-then-relax: try AND first, fall back to OR if < 2 results
    let results = searchAll(db, keywords, {
      project,
      limit: 8,
      prefix: true,
    });

    if (results.length < 2) {
      const andCount = results.length;
      const orResults = searchAll(db, keywords, {
        project,
        limit: 8,
        mode: 'OR',
        prefix: true,
      });
      if (orResults.length > andCount) {
        results = orResults;
        logToFile(HOOK_NAME, 'DEBUG', `FTS5 OR fallback: ${orResults.length} results (AND had ${andCount})`);
      }
    }

    // Temporal re-ranking: blend BM25 relevance with recency
    if (results.length > 0) {
      const now = Date.now();
      // FTS5 rank is negative (more negative = better match)
      // Find the "best" (most negative) rank to normalize against
      const minRank = Math.min(...results.map(r => r.rank));
      const maxRank = Math.max(...results.map(r => r.rank));
      const rankRange = maxRank - minRank;

      const scored = results.map(r => {
        // Normalize BM25: 0 = worst match, 1 = best match
        // rank is negative, so minRank is the best. Map minRank→1, maxRank→0
        const normalizedBM25 = rankRange === 0 ? 1 : (maxRank - r.rank) / rankRange;

        // Recency score: 1/(1 + daysSinceCreation)
        const epochMs = r.observation.timestamp_epoch;
        const daysSince = Math.max(0, (now - epochMs) / (1000 * 60 * 60 * 24));
        const recencyScore = 1 / (1 + daysSince);

        const finalScore = 0.7 * normalizedBM25 + 0.3 * recencyScore;
        return { result: r, finalScore };
      });

      scored.sort((a, b) => b.finalScore - a.finalScore);
      results = scored.map(s => s.result);
    }

    logToFile(HOOK_NAME, 'DEBUG', `FTS5 search returned ${results.length} results for "${keywords}"`);
    return results;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'FTS5 search failed, skipping', err);
    return [];
  }
}

/**
 * Get recent observations as fallback context.
 * Returns empty array if database is unavailable.
 *
 * @param db - Shared database handle (caller manages lifecycle)
 */
export async function getRecent(scope: Scope, db: import('better-sqlite3').Database | null): Promise<Observation[]> {
  try {
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database unavailable, skipping recent observations');
      return [];
    }

    const project = scope.type === 'project' ? scope.name : undefined;
    const recent = getRecentObservations(db, 8, project);
    logToFile(HOOK_NAME, 'DEBUG', `Got ${recent.length} recent observations`);
    return recent;
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Recent observations query failed, skipping', err);
    return [];
  }
}
