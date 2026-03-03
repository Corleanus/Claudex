/**
 * Claudex v2 — FTS5 Search Migrations
 *
 * Migration functions for creating FTS5 virtual tables and auto-sync triggers.
 * Extracted from search.ts to separate migration-time setup from runtime queries.
 *
 * Never throws — migrations are guarded by version checks.
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

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
