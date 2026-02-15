# Changelog

All notable changes to Claudex v2.

## [0.1.0] - 2026-02-15

### Phase 4: Polish, Observability & End-to-End Verification
- Added metrics collector with in-memory counters for hook timing, DB queries, and hologram calls
- Added health check endpoint reporting DB, hologram, and wrapper status
- Instrumented hook timing with latency budget warnings
- Added vector search abstraction layer (VectorStore interface with FTS5 adapter)
- Added end-to-end test suites covering session lifecycle, degradation tiers, compaction survival, and flat-file sync (139 new tests, bringing total to 325 passing)
- Added threshold config validation (warnThreshold < flushThreshold)
- Added comprehensive documentation (README, SETTINGS_EXAMPLE, CHANGELOG)

### Phase 3: Wrapper & Pre-Compaction Flush (`aaa518d`)
- Implemented pre-compaction flush wrapper with context-monitor and flush-trigger
- Added context window utilization assessment
- Implemented cooldown-based flush gating (file-based at `~/.claudex/db/.flush_cooldown`)
- Built three-tier degradation: hologram sidecar → DB pressure scores → recency fallback
- Added ResilientHologramClient with retry and automatic fallback
- Established `rescoreWithFallback()` as canonical re-score API
- Reasoning chain capture in pre-compact hook
- State capture in session-end hook (pressure scores, session summary)
- 43 new wrapper tests (`eba4d71`), bringing total to 186 passing

### Phase 2: Storage & Search (`705eaa5`..`020c17b`)
- Full SQLite schema: reasoning_chains, consensus_decisions, pressure_scores tables
- FTS5 full-text search with 3 virtual tables (observations_fts, reasoning_fts, consensus_fts)
- Auto-sync triggers keeping FTS5 indexes in sync with source tables
- Unified `searchAll()` querying across all tables
- Flat-file mirroring for observations, reasoning chains, consensus decisions, and pressure scores
- CRUD operations for all entity types
- Session lifecycle management: start → work → end with DB tracking
- Codex CP2 fixes: DB fallback wiring, mirror filenames, FTS5 optimize (`020c17b`)
- 74 new storage/search tests (`9cf4186`)

### Phase 1 Cleanup (`74b7ff4`..`d12b3d2`)
- Fixed session-end fail-safe to write `auto_handoff_*.md` instead of overwriting ACTIVE.md (`f1ef190`)
- Verified `timestamp_epoch` is milliseconds throughout; removed erroneous `* 1000` (`901f6da`)
- Gated observation capture and WAL mode behind config flags (`c09e58b`)
- Added FTS5 backfill with `INSERT INTO t(t) VALUES('rebuild')` command (`74b7ff4`)
- Added typed session status validation (`74b7ff4`)
- Fixed hologram NDJSON ping verification for stale port detection (`333fdf3`)
- Removed hologram exit cleanup to prevent detached-child file conflicts (`d12b3d2`)
- Foundational test suite: 69 tests across 4 modules (`4f6eb8c`)

### Phase 1: Foundation (`f63c113`)
- 21 work packages implemented by agent army (4 PMs + 20 workers)
- Hook infrastructure: 6 hooks (session-start, session-end, user-prompt-submit, post-tool-use, pre-compact, pre-flush)
- Hook harness (`_infrastructure.ts`): stdin/stdout JSON protocol, error handling, structured logging
- SQLite database: connection factory, WAL mode, migration system
- Schema: observations and sessions tables with full indexing
- Hologram sidecar integration: Python sidecar, TCP/NDJSON protocol, launcher, client
- Scope detection: project vs global scope from `projects.json`
- Observation extraction: per-tool rules with secret redaction
- Context assembly: token-budgeted markdown injection into conversation
- 12 shell wrappers (`.sh` + `.cmd`) for hook registration with Claude Code
- 4 Codex review checkpoints completed during implementation

### Phase 0: Documentation Verification (2026-02-14)
- Verified hologram-cognitive architecture docs against v0.3.3 codebase
- Found 99% accuracy between documentation and implementation
- Documented minor discrepancies; no full documentation redo needed
