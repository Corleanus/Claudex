/**
 * Claudex v2 — FTS5 Search Layer
 *
 * Provides full-text search across observations using SQLite FTS5.
 * searchObservations() returns ranked results with snippets.
 *
 * Migration functions live in search-migrations.ts; re-exported here
 * for backward compatibility.
 *
 * Never throws — returns empty results on error.
 */

import type Database from 'better-sqlite3';
import type { Observation, ObservationCategory, SearchResult } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { normalizeFts5Query } from '../shared/fts5-utils.js';
import { safeJsonParse } from '../shared/safe-json.js';

// Re-export migration functions for backward compatibility
export { migration_2, migration_4 } from './search-migrations.js';

const log = createLogger('search');

const VALID_CATEGORIES: readonly string[] = [
  'decision', 'discovery', 'bugfix', 'feature',
  'refactor', 'change', 'error', 'configuration',
] as const;

// =============================================================================
// Search
// =============================================================================

/** Row shape returned by the FTS5 search query */
interface SearchRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  tool_name: string;
  category: string;
  title: string;
  content: string | null;
  facts: string | null;
  files_read: string | null;
  files_modified: string | null;
  importance: number;
  rank: number;
  snippet: string;
}

function rowToObservation(row: SearchRow): Observation {
  return {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    tool_name: row.tool_name,
    category: VALID_CATEGORIES.includes(row.category)
      ? (row.category as ObservationCategory)
      : (() => { log.warn(`Unknown observation category '${row.category}', falling back to 'change'`); return 'change' as ObservationCategory; })(),
    title: row.title,
    content: row.content ?? '',
    facts: row.facts ? safeJsonParse<string[]>(row.facts, []) : undefined,
    files_read: row.files_read ? safeJsonParse<string[]>(row.files_read, []) : undefined,
    files_modified: row.files_modified ? safeJsonParse<string[]>(row.files_modified, []) : undefined,
    importance: row.importance,
  };
}

/**
 * Search observations using FTS5 full-text search.
 *
 * Query syntax (FTS5):
 * - Simple words: `typescript bug` (implicit AND)
 * - Prefix: `type*` matches typescript, types, etc.
 * - Phrases: `"memory leak"` matches exact phrase
 * - Boolean: `typescript OR javascript`
 * - Column filter: `title:refactor`
 *
 * Returns empty array on empty query or error.
 */
export function searchObservations(
  db: Database.Database,
  query: string,
  options?: {
    project?: string;
    limit?: number;
    category?: ObservationCategory;
    minImportance?: number;
    mode?: 'AND' | 'OR';
    prefix?: boolean;
  },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;
    const minImportance = options?.minImportance ?? 1;
    const project = options?.project;
    const category = options?.category ?? null;
    const useGlobalFilter = project === undefined || project === null;

    const sql = `
      SELECT o.id, o.session_id, o.project, o.timestamp, o.timestamp_epoch,
             o.tool_name, o.category, o.title, o.content,
             o.facts, o.files_read, o.files_modified, o.importance,
             fts.rank,
             snippet(observations_fts, 1, '<b>', '</b>', '...', 64) AS snippet
      FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
        AND ${useGlobalFilter ? 'o.project IS NULL' : 'o.project = ?'}
        AND (? IS NULL OR o.category = ?)
        AND o.importance >= ?
        AND o.deleted_at_epoch IS NULL
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed, { mode: options?.mode, prefix: options?.prefix });
    const params = useGlobalFilter
      ? [normalizedQuery, category, category, minImportance, limit]
      : [normalizedQuery, project, category, category, minImportance, limit];
    const rows = db.prepare(sql).all(...params) as SearchRow[];

    const result = rows.map(row => ({
      observation: rowToObservation(row),
      rank: row.rank,
      snippet: row.snippet ?? '',
    }));

    recordMetric('db.search_fts5', Date.now() - searchStart);
    return result;
  } catch (err) {
    recordMetric('db.search_fts5', Date.now() - searchStart, true);
    log.error('Search failed:', err);
    return [];
  }
}

// =============================================================================
// Reasoning Search
// =============================================================================

/** Row shape returned by the reasoning FTS5 search query */
interface ReasoningSearchRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  trigger: string;
  title: string;
  reasoning: string;
  decisions: string | null;
  files_involved: string | null;
  importance: number;
  created_at: string;
  created_at_epoch: number;
  rank: number;
  snippet: string;
}

function reasoningRowToSearchResult(row: ReasoningSearchRow): SearchResult {
  const observation: Observation = {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    tool_name: 'Flow',
    category: 'decision',
    title: row.title,
    content: row.reasoning,
    facts: row.decisions ? safeJsonParse<string[]>(row.decisions, []) : undefined,
    files_read: row.files_involved ? safeJsonParse<string[]>(row.files_involved, []) : undefined,
    importance: row.importance,
  };
  return { observation, rank: row.rank, snippet: row.snippet ?? '' };
}

/**
 * Search reasoning_chains using FTS5 full-text search.
 * Returns results mapped to SearchResult[] with Observation-like shape.
 */
export function searchReasoning(
  db: Database.Database,
  query: string,
  options?: { project?: string; limit?: number; mode?: 'AND' | 'OR'; prefix?: boolean },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;
    const project = options?.project;
    const useGlobalFilter = project === undefined || project === null;

    const sql = `
      SELECT r.id, r.session_id, r.project, r.timestamp, r.timestamp_epoch,
             r.trigger, r.title, r.reasoning, r.decisions, r.files_involved,
             r.importance, r.created_at, r.created_at_epoch,
             fts.rank,
             snippet(reasoning_fts, 1, '<b>', '</b>', '...', 64) AS snippet
      FROM reasoning_fts fts
      JOIN reasoning_chains r ON r.id = fts.rowid
      WHERE reasoning_fts MATCH ?
        AND ${useGlobalFilter ? 'r.project IS NULL' : 'r.project = ?'}
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed, { mode: options?.mode, prefix: options?.prefix });
    const params = useGlobalFilter
      ? [normalizedQuery, limit]
      : [normalizedQuery, project, limit];
    const rows = db.prepare(sql).all(...params) as ReasoningSearchRow[];

    const result = rows.map(reasoningRowToSearchResult);
    recordMetric('db.search_fts5', Date.now() - searchStart);
    return result;
  } catch (err) {
    recordMetric('db.search_fts5', Date.now() - searchStart, true);
    log.error('Reasoning search failed:', err);
    return [];
  }
}

// =============================================================================
// Consensus Search
// =============================================================================

/** Row shape returned by the consensus FTS5 search query */
interface ConsensusSearchRow {
  id: number;
  session_id: string;
  project: string | null;
  timestamp: string;
  timestamp_epoch: number;
  title: string;
  description: string;
  claude_position: string | null;
  codex_position: string | null;
  human_verdict: string | null;
  status: string;
  tags: string | null;
  files_affected: string | null;
  importance: number;
  created_at: string;
  created_at_epoch: number;
  rank: number;
  snippet: string;
}

function consensusRowToSearchResult(row: ConsensusSearchRow): SearchResult {
  const observation: Observation = {
    id: row.id,
    session_id: row.session_id,
    project: row.project ?? undefined,
    timestamp: row.timestamp,
    timestamp_epoch: row.timestamp_epoch,
    tool_name: 'Consensus',
    category: 'decision',
    title: row.title,
    content: row.description,
    facts: row.tags ? safeJsonParse<string[]>(row.tags, []) : undefined,
    files_modified: row.files_affected ? safeJsonParse<string[]>(row.files_affected, []) : undefined,
    importance: row.importance,
  };
  return { observation, rank: row.rank, snippet: row.snippet ?? '' };
}

/**
 * Search consensus_decisions using FTS5 full-text search.
 * Returns results mapped to SearchResult[] with Observation-like shape.
 */
function searchConsensus(
  db: Database.Database,
  query: string,
  options?: { project?: string; limit?: number; mode?: 'AND' | 'OR'; prefix?: boolean },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;
    const project = options?.project;
    const useGlobalFilter = project === undefined || project === null;

    const sql = `
      SELECT c.id, c.session_id, c.project, c.timestamp, c.timestamp_epoch,
             c.title, c.description, c.claude_position, c.codex_position,
             c.human_verdict, c.status, c.tags, c.files_affected,
             c.importance, c.created_at, c.created_at_epoch,
             fts.rank,
             snippet(consensus_fts, 1, '<b>', '</b>', '...', 64) AS snippet
      FROM consensus_fts fts
      JOIN consensus_decisions c ON c.id = fts.rowid
      WHERE consensus_fts MATCH ?
        AND ${useGlobalFilter ? 'c.project IS NULL' : 'c.project = ?'}
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed, { mode: options?.mode, prefix: options?.prefix });
    const params = useGlobalFilter
      ? [normalizedQuery, limit]
      : [normalizedQuery, project, limit];
    const rows = db.prepare(sql).all(...params) as ConsensusSearchRow[];

    const result = rows.map(consensusRowToSearchResult);
    recordMetric('db.search_fts5', Date.now() - searchStart);
    return result;
  } catch (err) {
    recordMetric('db.search_fts5', Date.now() - searchStart, true);
    log.error('Consensus search failed:', err);
    return [];
  }
}

// =============================================================================
// Unified Search
// =============================================================================

/**
 * Unified search across ALL FTS5 tables (observations, reasoning, consensus).
 * Merges results, sorts by rank (most relevant first), and applies limit.
 * This is the primary search entry point for Phase 2.
 */
export function searchAll(
  db: Database.Database,
  query: string,
  options?: { project?: string; limit?: number; mode?: 'AND' | 'OR'; prefix?: boolean },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;

    const prefix = options?.prefix;
    const obsResults = searchObservations(db, trimmed, { project: options?.project, limit, mode: options?.mode, prefix });
    const reasoningResults = searchReasoning(db, trimmed, { project: options?.project, limit, mode: options?.mode, prefix });
    const consensusResults = searchConsensus(db, trimmed, { project: options?.project, limit, mode: options?.mode, prefix });

    // Merge all results and sort by rank (BM25 — lower/more negative = more relevant)
    const merged = [...obsResults, ...reasoningResults, ...consensusResults];
    merged.sort((a, b) => a.rank - b.rank);

    const result = merged.slice(0, limit);
    recordMetric('db.search_fts5', Date.now() - searchStart);
    return result;
  } catch (err) {
    recordMetric('db.search_fts5', Date.now() - searchStart, true);
    log.error('Unified search failed:', err);
    return [];
  }
}

/**
 * Rebuild all FTS5 indexes from their content tables.
 * Use after bulk operations that bypass triggers (e.g., direct DELETE).
 */
export function rebuildSearchIndex(db: Database.Database): void {
  try {
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
    db.exec(`INSERT INTO reasoning_fts(reasoning_fts) VALUES('rebuild')`);
    db.exec(`INSERT INTO consensus_fts(consensus_fts) VALUES('rebuild')`);
    log.info('All FTS5 indexes rebuilt');
  } catch (err) {
    log.error('FTS5 rebuild failed:', err);
  }
}

/**
 * Optimize the FTS5 index. Run periodically (e.g., on SessionEnd) to merge
 * internal b-tree segments and reclaim space.
 */
export function optimizeSearchIndex(db: Database.Database): void {
  try {
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('optimize')`);
    db.exec(`INSERT INTO reasoning_fts(reasoning_fts) VALUES('optimize')`);
    db.exec(`INSERT INTO consensus_fts(consensus_fts) VALUES('optimize')`);
    log.info('All FTS5 indexes optimized');
  } catch (err) {
    log.error('FTS5 optimize failed:', err);
  }
}
