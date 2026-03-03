# Unified Code Review Report

**Scope:** uncommitted changes (staged + unstaged) — 34 files, 2100 lines changed
**Date:** 2026-02-28 18:30 UTC
**Grade:** C
**Perspectives:** Quality [OK], Acceptance [OK], Security [OK], General [FAILED: timeout after 18m]

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

### [ACCEPTANCE] Unified post-compact can suppress all context output
**File:** src/lib/context-assembler.ts:101
**Issue:** When `useUnifiedPath` is true but `buildUnifiedResumeSection()` returns empty string (e.g., active GSD with `position=null`), no unified content is appended AND the standard assembly path is skipped. The function returns only the header — effectively no context output.
**Recommendation:** Compute unified content first and only enable unified path if it is non-empty; otherwise fall back to standard assembly path.

---

## Recommended

### [QUALITY] Public type exports removed from checkpoint/writer
**File:** src/checkpoint/writer.ts:54
**Issue:** Public type exports were removed (e.g., `WriteCheckpointInput`, `WriteCheckpointResult`). This changes the module contract and breaks typed consumers that import these names.
**Recommendation:** Keep deprecated exports for a transition period, or verify no external consumers exist before removing.

### [QUALITY][ACCEPTANCE] searchConsensus export removed without compatibility shim
**File:** src/db/search.ts:289
**Issue:** `searchConsensus` changed from exported to internal with no compatibility shim. Existing consumers importing this API will break.
**Recommendation:** Keep deprecated wrapper/re-export for a transition period, or explicitly version-break with migration notes.

### [QUALITY][ACCEPTANCE] Source attribution misleading when unified append fails
**File:** src/lib/context-assembler.ts:119
**Issue:** `contributedSources.push('hologram')` and `push('session')` happen unconditionally after `tryAppend(unified, 'gsd')`, regardless of whether the append succeeded. This produces misleading source metadata.
**Recommendation:** Only add source tags if the unified section append actually succeeds (check `tryAppend` return value).

### [QUALITY] Metrics writes silently skipped on exception
**File:** src/hooks/user-prompt-submit.ts:354
**Issue:** Any exception during STATE.md stat/read forces `shouldWriteMetrics=false`, silently skipping metrics writes instead of degrading gracefully like nearby non-fatal paths.
**Recommendation:** Narrow the catch scope or degrade gracefully (write metrics even if STATE.md read fails).

### [ACCEPTANCE] Post-compact detection can repeat across multiple prompts
**File:** src/hooks/user-prompt-submit.ts:201
**Issue:** `postCompaction` detection can repeat when `active_files` is empty because boost state is only committed when `boostFiles` exists. Post-compact mode remains true until staleness timeout.
**Recommendation:** Mark post-compact as consumed even when there are no boost files (update checkpoint state with turn count 1 after first render).

### [SECURITY] STATE.md write path lacks symlink/path safety checks
**File:** src/hooks/user-prompt-submit.ts:360
**Issue:** New automatic write paths to `STATE.md` through `writeClaudexMetricsToState` use `fs.writeFileSync` + rename without symlink/path safety checks. A crafted `.planning/STATE.md.claudex-tmp` symlink could clobber unintended files.
**Recommendation:** Harden writes with `lstat`/`realpath` checks, reject symlinks, create temp files with exclusive flags, verify destination remains inside `<project>/.planning`.

### [SECURITY] Raw stdin preview leaked in error logs
**File:** src/hooks/_infrastructure.ts:34
**Issue:** Invalid stdin JSON throws an error containing `raw.slice(0, 200)`, which is logged by `runHook` error handling. This can leak prompt content/secrets.
**Recommendation:** Remove raw payload echo from exception text; log only length/schema error metadata.

---

## Observations

### [QUALITY] Unsafe never cast in exhaustive switch
**File:** src/gsd/phase-transition-cli.ts:234
**Issue:** The exhaustive default branch casts `never` to `{ event: string }`, weakening strict exhaustiveness guarantees.
**Recommendation:** Use a proper exhaustive check helper that throws at runtime.

### [QUALITY] ContextUtilization export removed
**File:** src/wrapper/context-monitor.ts:12
**Issue:** `ContextUtilization` is no longer exported while typed imports may still exist in consumer code/tests.
**Recommendation:** Verify no consumers depend on this type before removing the export.

### [SECURITY] Checkpoint content injected without sanitization
**File:** src/hooks/user-prompt-submit.ts:224
**Issue:** Checkpoint-GSD fallback loads persisted checkpoint content and injects it into unified resume context without content sanitization. A poisoned checkpoint could contain instruction-like text.
**Recommendation:** Treat checkpoint strings as untrusted: sanitize markdown control content, constrain field length, prefix with data-only framing.
