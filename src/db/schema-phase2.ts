/**
 * Claudex v2 — Phase 2 Schema: Reasoning, Consensus, Pressure
 *
 * Migration 3: Three new tables for the full storage layer.
 * - reasoning_chains: Flow reasoning that survives compaction
 * - consensus_decisions: Three-way agreement records
 * - pressure_scores: Hologram attention routing persistence
 */

import type { MigrationRunner } from './migrations.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('schema-phase2');

export function migration_3(runner: MigrationRunner): void {
  if (runner.hasVersion(3)) {
    log.debug('Migration 3 already applied, skipping');
    return;
  }

  log.info('Applying migration 3: reasoning_chains, consensus_decisions, pressure_scores');

  runner.db.exec(`
    CREATE TABLE reasoning_chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      title TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      decisions TEXT,
      files_involved TEXT,
      importance INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX idx_reasoning_session ON reasoning_chains(session_id);
    CREATE INDEX idx_reasoning_project ON reasoning_chains(project);
    CREATE INDEX idx_reasoning_epoch ON reasoning_chains(timestamp_epoch DESC);

    CREATE TABLE consensus_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project TEXT,
      timestamp TEXT NOT NULL,
      timestamp_epoch INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      claude_position TEXT,
      codex_position TEXT,
      human_verdict TEXT,
      status TEXT CHECK(status IN ('proposed', 'agreed', 'rejected', 'superseded')) DEFAULT 'proposed',
      tags TEXT,
      files_affected TEXT,
      importance INTEGER NOT NULL DEFAULT 4,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX idx_consensus_session ON consensus_decisions(session_id);
    CREATE INDEX idx_consensus_project ON consensus_decisions(project);
    CREATE INDEX idx_consensus_status ON consensus_decisions(status);
    CREATE INDEX idx_consensus_epoch ON consensus_decisions(timestamp_epoch DESC);

    CREATE TABLE pressure_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      project TEXT,
      raw_pressure REAL NOT NULL DEFAULT 0.0,
      temperature TEXT CHECK(temperature IN ('HOT', 'WARM', 'COLD')) DEFAULT 'COLD',
      last_accessed_epoch INTEGER,
      decay_rate REAL DEFAULT 0.05,
      updated_at TEXT NOT NULL,
      updated_at_epoch INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_pressure_file_project ON pressure_scores(file_path, project);
    CREATE INDEX idx_pressure_temperature ON pressure_scores(temperature);
    CREATE INDEX idx_pressure_raw ON pressure_scores(raw_pressure DESC);
  `);

  runner.recordVersion(3);
  log.info('Migration 3 applied successfully');
}
