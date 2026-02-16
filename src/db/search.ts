/**
 * Claudex v2 — FTS5 Search Layer
 *
 * Provides full-text search across observations using SQLite FTS5.
 * Migration 2 creates the FTS5 virtual table and auto-sync triggers.
 * searchObservations() returns ranked results with snippets.
 *
 * Never throws — returns empty results on error.
 */

import type Database from 'better-sqlite3';
import type { Observation, ObservationCategory, SearchResult } from '../shared/types.js';
import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import { normalizeFts5Query } from '../shared/fts5-utils.js';

const log = createLogger('search');

// =============================================================================
// Migration 2: FTS5 virtual table + auto-sync triggers
// =============================================================================

/**
 * Migration 2: Create FTS5 virtual table for observations and triggers to keep it in sync.
 * Runs inside a transaction to ensure atomicity.
 */
export function migration_2(runner: MigrationRunner): void {
  if (runner.hasVersion(2)) {
    log.debug('Migration 2 already applied, skipping');
    return;
  }

  log.info('Applying migration 2: FTS5 virtual table + triggers');

  runner.db.exec(`
    CREATE VIRTUAL TABLE observations_fts USING fts5(
      title, content, facts,
      content='observations', content_rowid='id'
    );

    CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO observations_fts(rowid, title, content, facts)
      VALUES (new.id, new.title, new.content, new.facts);
    END;

    CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, facts)
      VALUES ('delete', old.id, old.title, old.content, old.facts);
    END;

    CREATE TRIGGER observations_au AFTER UPDATE ON observations BEGIN
      INSERT INTO observations_fts(observations_fts, rowid, title, content, facts)
      VALUES ('delete', old.id, old.title, old.content, old.facts);
      INSERT INTO observations_fts(rowid, title, content, facts)
      VALUES (new.id, new.title, new.content, new.facts);
    END;
  `);

  // Backfill: rebuild FTS5 index from content table to capture pre-existing rows
  // Content-sync FTS5 tables require 'rebuild' — manual INSERT doesn't work
  runner.db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);

  runner.recordVersion(2);
  log.info('Migration 2 applied successfully');
}

// =============================================================================
// Migration 4: FTS5 for reasoning_chains + consensus_decisions
// =============================================================================

/**
 * Migration 4: Create FTS5 virtual tables for reasoning_chains and consensus_decisions
 * with auto-sync triggers. Follows the same pattern as migration_2.
 * Runs inside a transaction to ensure atomicity.
 */
export function migration_4(runner: MigrationRunner): void {
  if (runner.hasVersion(4)) {
    log.debug('Migration 4 already applied, skipping');
    return;
  }

  log.info('Applying migration 4: FTS5 for reasoning_chains + consensus_decisions');

  runner.db.exec(`
    CREATE VIRTUAL TABLE reasoning_fts USING fts5(
      title, reasoning, decisions,
      content='reasoning_chains', content_rowid='id'
    );

    CREATE TRIGGER reasoning_ai AFTER INSERT ON reasoning_chains BEGIN
      INSERT INTO reasoning_fts(rowid, title, reasoning, decisions)
      VALUES (new.id, new.title, new.reasoning, new.decisions);
    END;

    CREATE TRIGGER reasoning_ad AFTER DELETE ON reasoning_chains BEGIN
      INSERT INTO reasoning_fts(reasoning_fts, rowid, title, reasoning, decisions)
      VALUES ('delete', old.id, old.title, old.reasoning, old.decisions);
    END;

    CREATE TRIGGER reasoning_au AFTER UPDATE ON reasoning_chains BEGIN
      INSERT INTO reasoning_fts(reasoning_fts, rowid, title, reasoning, decisions)
      VALUES ('delete', old.id, old.title, old.reasoning, old.decisions);
      INSERT INTO reasoning_fts(rowid, title, reasoning, decisions)
      VALUES (new.id, new.title, new.reasoning, new.decisions);
    END;

    CREATE VIRTUAL TABLE consensus_fts USING fts5(
      title, description, claude_position, codex_position, human_verdict,
      content='consensus_decisions', content_rowid='id'
    );

    CREATE TRIGGER consensus_ai AFTER INSERT ON consensus_decisions BEGIN
      INSERT INTO consensus_fts(rowid, title, description, claude_position, codex_position, human_verdict)
      VALUES (new.id, new.title, new.description, new.claude_position, new.codex_position, new.human_verdict);
    END;

    CREATE TRIGGER consensus_ad AFTER DELETE ON consensus_decisions BEGIN
      INSERT INTO consensus_fts(consensus_fts, rowid, title, description, claude_position, codex_position, human_verdict)
      VALUES ('delete', old.id, old.title, old.description, old.claude_position, old.codex_position, old.human_verdict);
    END;

    CREATE TRIGGER consensus_au AFTER UPDATE ON consensus_decisions BEGIN
      INSERT INTO consensus_fts(consensus_fts, rowid, title, description, claude_position, codex_position, human_verdict)
      VALUES ('delete', old.id, old.title, old.description, old.claude_position, old.codex_position, old.human_verdict);
      INSERT INTO consensus_fts(rowid, title, description, claude_position, codex_position, human_verdict)
      VALUES (new.id, new.title, new.description, new.claude_position, new.codex_position, new.human_verdict);
    END;
  `);

  // Backfill: rebuild FTS5 indexes from content tables
  runner.db.exec(`INSERT INTO reasoning_fts(reasoning_fts) VALUES('rebuild')`);
  runner.db.exec(`INSERT INTO consensus_fts(consensus_fts) VALUES('rebuild')`);

  runner.recordVersion(4);
  log.info('Migration 4 applied successfully');
}

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
    category: row.category as ObservationCategory,
    title: row.title,
    content: row.content ?? '',
    facts: row.facts ? JSON.parse(row.facts) : undefined,
    files_read: row.files_read ? JSON.parse(row.files_read) : undefined,
    files_modified: row.files_modified ? JSON.parse(row.files_modified) : undefined,
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
    const project = options?.project ?? null;
    const category = options?.category ?? null;

    const sql = `
      SELECT o.id, o.session_id, o.project, o.timestamp, o.timestamp_epoch,
             o.tool_name, o.category, o.title, o.content,
             o.facts, o.files_read, o.files_modified, o.importance,
             fts.rank,
             snippet(observations_fts, 1, '<b>', '</b>', '...', 32) AS snippet
      FROM observations_fts fts
      JOIN observations o ON o.id = fts.rowid
      WHERE observations_fts MATCH ?
        AND (? IS NULL OR o.project = ?)
        AND (? IS NULL OR o.category = ?)
        AND o.importance >= ?
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed);
    const rows = db.prepare(sql).all(
      normalizedQuery,
      project, project,
      category, category,
      minImportance,
      limit,
    ) as SearchRow[];

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
    facts: row.decisions ? JSON.parse(row.decisions) : undefined,
    files_read: row.files_involved ? JSON.parse(row.files_involved) : undefined,
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
  options?: { project?: string; limit?: number },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;
    const project = options?.project ?? null;

    const sql = `
      SELECT r.id, r.session_id, r.project, r.timestamp, r.timestamp_epoch,
             r.trigger, r.title, r.reasoning, r.decisions, r.files_involved,
             r.importance, r.created_at, r.created_at_epoch,
             fts.rank,
             snippet(reasoning_fts, 1, '<b>', '</b>', '...', 32) AS snippet
      FROM reasoning_fts fts
      JOIN reasoning_chains r ON r.id = fts.rowid
      WHERE reasoning_fts MATCH ?
        AND (? IS NULL OR r.project = ?)
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed);
    const rows = db.prepare(sql).all(
      normalizedQuery,
      project, project,
      limit,
    ) as ReasoningSearchRow[];

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
    facts: row.tags ? JSON.parse(row.tags) : undefined,
    files_modified: row.files_affected ? JSON.parse(row.files_affected) : undefined,
    importance: row.importance,
  };
  return { observation, rank: row.rank, snippet: row.snippet ?? '' };
}

/**
 * Search consensus_decisions using FTS5 full-text search.
 * Returns results mapped to SearchResult[] with Observation-like shape.
 */
export function searchConsensus(
  db: Database.Database,
  query: string,
  options?: { project?: string; limit?: number },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;
    const project = options?.project ?? null;

    const sql = `
      SELECT c.id, c.session_id, c.project, c.timestamp, c.timestamp_epoch,
             c.title, c.description, c.claude_position, c.codex_position,
             c.human_verdict, c.status, c.tags, c.files_affected,
             c.importance, c.created_at, c.created_at_epoch,
             fts.rank,
             snippet(consensus_fts, 1, '<b>', '</b>', '...', 32) AS snippet
      FROM consensus_fts fts
      JOIN consensus_decisions c ON c.id = fts.rowid
      WHERE consensus_fts MATCH ?
        AND (? IS NULL OR c.project = ?)
      ORDER BY fts.rank
      LIMIT ?
    `;

    const normalizedQuery = normalizeFts5Query(trimmed);
    const rows = db.prepare(sql).all(
      normalizedQuery,
      project, project,
      limit,
    ) as ConsensusSearchRow[];

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
  options?: { project?: string; limit?: number },
): SearchResult[] {
  const searchStart = Date.now();
  try {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options?.limit ?? 10;

    const obsResults = searchObservations(db, trimmed, { project: options?.project, limit });
    const reasoningResults = searchReasoning(db, trimmed, { project: options?.project, limit });
    const consensusResults = searchConsensus(db, trimmed, { project: options?.project, limit });

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
