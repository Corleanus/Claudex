# Changelog

All notable changes to Claudex v2.

## [1.0.0] - 2026-03-05

### Public Release
- Added AGPL-3.0 license
- Added `npx claudex setup` CLI for automated installation
- Added config.example.json with documented defaults
- Added GitHub issue templates (bug report, feature request)
- Updated README with prerequisites, quick-start guide, and feature status
- Updated CHANGELOG with complete version history

## [0.5.0] - 2026-03-04

### Incremental Checkpointing for 1M Context Windows
- Added conservative window size detection (default 200k, upgrade to 1M on heuristic evidence)
- Added single-pass `readTokenGaugeWithDetection()` API eliminating double transcript reads
- Added gated incremental thresholds (2 checkpoints for 200k, 6 for 1M)
- Added threshold state tracking with window size change detection
- Incremental checkpoints skip state archival for full session accumulation
- Config override `checkpoint.window_size` applied consistently across all hooks
- Resolved 14 code quality findings from unified review
- 43 new lifecycle tests

## [0.4.0] - 2026-02-27

### Memory System Upgrade (C+ → A)
- Implemented stratified decay engine with tier-specific half-lives
- Added quality-gated observation capture (filters trivial/noisy observations)
- Added importance-based observation filtering
- Observation flat-file mirror killed — DB is sole authoritative store
- Token gauge counts cached tokens correctly
- Replaced console.error with structured logger throughout
- Added log rotation at 5MB
- Added systemMessage to HookStdout type
- Lowered checkpoint threshold from 80% to 75% for auto-compact runway
- Fixed DB tests with proper migration runner
- 35 new tests, grade A achieved

## [0.3.0] - 2026-02-24

### GSD Integration (Phase-Aware Context)
- Added GSD state reader module (reads `.planning/` directory structure)
- Added phase relevance engine for context-aware file boosting
- Added cross-phase summary writer
- Added phase transition handlers and CLI entry point
- Wired GSD context into user-prompt-submit pipeline
- Added `[phase]` annotation to context assembler hot/warm sections
- Extended ContextSources with GSD fields and buildGsdSection
- Added plan file analysis: findActivePlanFile, extractPlanMustHaves, countCompletedRequirements
- 8 phases implemented across 12 work packages

## [0.2.0] - 2026-02-19

### Context Management v3
- Implemented token gauge for context window utilization tracking
- Added checkpoint writer with full state capture (Phase 10)
- Added compact checkpoints with hologram project awareness and post-compact bridge
- Added local pressure scoring in post-tool-use hook
- Improved pre-compact reasoning chain capture
- Added structured logger replacing console.error throughout
- Hardening pass resolving all CRITICALs, HIGHs, and 12 MEDIUMs from Codex review
- Added sidecar `__main__.py` for Python directory execution
- Added hologram integration tests with real Python sidecar
- Phases 7-9: hologram integration, data governance, hardening
- Session-end close all entries + smart hologram retry
- 3 Codex-accepted fixes: boost counter, LRU cache, array validation

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
