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

const log = createLogger('search');

// =============================================================================
// Migration 2: FTS5 virtual table + auto-sync triggers
// =============================================================================

/**
 * Migration 2: Create FTS5 virtual table for observations and triggers to keep it in sync.
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

    const rows = db.prepare(sql).all(
      trimmed,
      project, project,
      category, category,
      minImportance,
      limit,
    ) as SearchRow[];

    return rows.map(row => ({
      observation: rowToObservation(row),
      rank: row.rank,
      snippet: row.snippet ?? '',
    }));
  } catch (err) {
    log.error('Search failed:', err);
    return [];
  }
}

/**
 * Rebuild the FTS5 index from the observations table.
 * Use after bulk operations that bypass triggers (e.g., direct DELETE).
 */
export function rebuildSearchIndex(db: Database.Database): void {
  try {
    db.exec(`INSERT INTO observations_fts(observations_fts) VALUES('rebuild')`);
    log.info('FTS5 index rebuilt');
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
    log.info('FTS5 index optimized');
  } catch (err) {
    log.error('FTS5 optimize failed:', err);
  }
}
