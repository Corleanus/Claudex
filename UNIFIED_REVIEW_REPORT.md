# Unified Code Review Report

**Scope:** Uncommitted changes — Incremental Checkpointing (9 files, 262 lines)
**Date:** 2026-03-05 22:10 UTC
**Grade:** C
**Perspectives:** Quality [OK], Acceptance [OK], Security [OK], General [OK], Reuse [OK], Efficiency [OK], Code-Health [OK]

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| A | No critical, <=2 recommended |
| B | No critical, 3-5 recommended |
| C | No critical, 6+ recommended OR 1 critical |
| D | 2-3 critical |
| F | 4+ critical |

---

## Critical

### [ACCEPTANCE] Threshold state doesn't account for window size changes
**File:** src/hooks/post-tool-use.ts:229
**Issue:** `.incremental-cp.json` stores `last_threshold_index` but not the window size used to compute thresholds. If window size changes mid-session (e.g., model detection returns different result, or config is updated), `crossedIndex` from the new threshold array can never exceed the stored index, suppressing all future incremental checkpoints.
**Recommendation:** Persist `window_size` in `.incremental-cp.json` and reset `last_threshold_index` when window size changes.

---

## Recommended

### [QUALITY][ACCEPTANCE][GENERAL][REUSE][CODE-HEALTH] Config override inconsistency across hooks
**File:** src/hooks/post-tool-use.ts:201, src/hooks/pre-compact.ts:402
**Issue:** `checkpoint.window_size` config override is passed to `detectWindowSize()` in `user-prompt-submit` but omitted in `post-tool-use` and `pre-compact`. Different hooks can compute different window sizes for the same session.
**Recommendation:** Centralize window resolution in one shared helper (e.g., `resolveCheckpointWindowSize(config, transcriptPath)`) and call it from all three hooks.

### [QUALITY][GENERAL][SECURITY] Window detection assumes capability, not activation
**File:** src/lib/token-gauge.ts:227
**Issue:** `detectWindowSize()` maps model family to 1M capability even when 1M may not be active (requires beta header). For Opus/Sonnet sessions without 1M activation, window size is overstated, utilization is underreported, and checkpoint triggers fire late.
**Recommendation:** Default to 200k for ambiguous cases (safe: earlier checkpoints). Only return 1M when explicitly configured via `checkpoint.window_size`, or when heuristic confirms 1M (tokens exceed 195k).

### [QUALITY][GENERAL][REUSE][EFFICIENCY][CODE-HEALTH] Double transcript read on hot path
**File:** src/hooks/post-tool-use.ts:201, src/lib/token-gauge.ts:213
**Issue:** `detectWindowSize()` and `readTokenGauge()` each perform full synchronous `readFileSync` + JSONL parse of the transcript. On `post-tool-use` (fires every tool call), this doubles I/O on the hottest path.
**Recommendation:** Add a single-pass API (e.g., `readTokenGaugeWithDetection(transcriptPath, configOverride?)`) that reads once and returns both window size and gauge reading. `extractLastUsage` and `extractModelName` share identical BOM-strip/split/reverse-scan logic — extract a common backward scanner.

### [GENERAL][EFFICIENCY] Aggressive thresholds for 200k sessions
**File:** src/lib/token-gauge.ts:61
**Issue:** Percentage-based thresholds (15%, 30%, ...) apply to all window sizes. For 200k, this means 6 incremental checkpoints starting at 30k tokens — a major behavior change from the previous single checkpoint at 167k. Increases I/O and storage for sessions that don't need it.
**Recommendation:** Gate dense thresholds to large windows (>200k), or enforce a minimum absolute token delta between checkpoints (e.g., 100k minimum).

### [GENERAL] Missing lifecycle tests
**File:** src/checkpoint/writer.ts:346
**Issue:** No tests for: (1) incremental trigger skipping `archiveStateFiles`, (2) threshold crossing behavior in `post-tool-use` with `.incremental-cp.json`, (3) config override propagation consistency across hooks.
**Recommendation:** Add targeted integration tests for the new archive semantics and threshold advancement logic.

### [SECURITY] Unarchived state retains sensitive content longer
**File:** src/checkpoint/writer.ts:343
**Issue:** Incremental checkpoints no longer archive/reset live state files. Secrets in decisions/questions persist in state files for the full session, increasing exposure window. Subsequent prompts continue to inject this state.
**Recommendation:** Add TTL/size caps for active state files, or scrub sensitive fields before reinjection. Consider periodic state rotation independent of checkpoint archiving.

---

## Observations

### [CODE-HEALTH] Writer embeds orchestration policy
**File:** src/checkpoint/writer.ts:346
**Issue:** `writeCheckpoint` now contains `if (trigger !== 'incremental')` — a persistence module depends on higher-level lifecycle semantics.
**Recommendation:** Move archival policy to callers or pass an explicit `archiveState` option. If policy stays in writer, prefer an allowlist of "final" triggers over a negative check.

### [GENERAL][REUSE] Stale comments referencing old constants
**File:** src/hooks/post-tool-use.ts:28
**Issue:** Comments still reference `INCREMENTAL_THRESHOLDS` as if it were the runtime source. Post-refactor, runtime uses dynamic `getIncrementalThresholds(windowSize)`.
**Recommendation:** Update comments to match current behavior.

### [REUSE] Test helpers not extended for new tests
**File:** tests/lib/token-gauge.test.ts:303
**Issue:** New `detectWindowSize` tests inline assistant JSON payloads instead of extending `makeAssistantLine` to accept a `model` parameter.
**Recommendation:** Add `makeAssistantLineWithModel(inputTokens, model, outputTokens?)` helper and use it.
