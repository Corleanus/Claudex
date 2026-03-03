---
phase: "Phase 5: Code Smells"
plan: 05-01
status: complete
started: 2026-02-27
completed: 2026-02-27
key-files:
  created: []
  modified:
    - src/lib/decay-engine.ts
    - src/db/audit.ts
    - src/hooks/session-end.ts
    - src/hooks/user-prompt-submit.ts
    - src/lib/retention.ts
    - src/wrapper/flush-trigger.ts
    - src/shared/config.ts
    - src/lib/context-assembler.ts
    - src/gsd/cross-phase-writer.ts
    - src/gsd/phase-transition-cli.ts
    - src/checkpoint/writer.ts
---

# Plan 05-01 Summary: Audit and Resolve Code Smell Findings

## What Was Done

Resolved all 24 open code smell findings across 18 files. 10 findings were resolved by code changes, 15 by wontfix classification with rationale.

### Code Changes

**WP-01 — Magic numbers (6 files changed, 6 wontfix)**
- `src/lib/decay-engine.ts`: Extracted `MS_PER_DAY = 86_400_000` at module scope, replaced bare `86400000` divisors in day-since-access calculations.
- `src/db/audit.ts`: Extracted `MS_PER_DAY = 24 * 60 * 60 * 1000` in `cleanOldAuditLogs()`.
- `src/hooks/session-end.ts`: Extracted `STALE_LOCK_MS = 5000` in stale-lock detection block.
- `src/hooks/user-prompt-submit.ts`: Extracted `METRICS_STALENESS_MS = 5 * 60 * 1000` in metrics debounce block.
- `src/lib/retention.ts`: Extracted `MS_PER_DAY = 24 * 60 * 60 * 1000` in `enforceRetention()`.
- `src/wrapper/flush-trigger.ts`: Extracted `MAX_REASONING_CHARS = 10_000` at module scope.
- 6 false positives (already named constants) resolved as wontfix: cross-phase-writer DEBOUNCE_MS, summary-writer DEBOUNCE_MS, recovery.ts named constants, logger MAX_LOG_SIZE, epoch.ts documented 1e12, token-gauge 1000 formatting boundary.

**WP-02 — Non-null assertions (3 files changed)**
- `src/shared/config.ts`: Extracted default sub-objects (`hDef`, `dbDef`, `hookDef`, `obsDef`, `wrapDef`, `vecDef`) once at function top, eliminating 17 repeated `defaults.hologram!` etc. assertions.
- `src/hooks/user-prompt-submit.ts`: Extracted `const pos = gsdState?.position` to eliminate `gsdState!.position!.phase` assertion inside guarded block.
- `src/lib/context-assembler.ts`: Extracted `const hologram = sources.hologram` to eliminate 4 `sources.hologram!` assertions in HOT/WARM sections.

**WP-05 — Sort comparators (1 file changed)**
- `src/gsd/cross-phase-writer.ts`: Added explicit `(a, b) => a.localeCompare(b)` comparators to 2 `.sort()` calls (session files, archive entries).

**WP-06 — Switch exhaustiveness (1 file changed)**
- `src/gsd/phase-transition-cli.ts`: Added `default: { const _exhaustive: never = parsed; throw new Error(...); }` for compile-time and runtime exhaustiveness checking.

**WP-09 — Signature variance (1 file changed)**
- `src/checkpoint/writer.ts`: Renamed local `estimateTokens(checkpoint: Checkpoint)` to `estimateCheckpointTokens()` to disambiguate from `estimateTokens(text: string)` in context-sections.ts and loader.ts.

### Wontfix Classifications

- **WP-03** (3 findings): catch-return-default in decay-engine.ts, health.ts — intentional never-throws APIs, already logging before returning defaults.
- **WP-04** (1 finding): console.error in phase-transition-cli.ts — CLI entry point where `process.exit(1)` serves as the error exit path.
- **WP-07** (1 finding): Monster function in writer.ts — 151 LOC (1 over threshold), sequential pipeline, well-sectioned. Splitting would create single-caller helpers.
- **WP-08** (1 finding): Dead function in protocol.ts — factory function where return-only body IS the pattern. Actively used in launcher.ts and client.ts.
- **WP-01 extras**: config.ts validation bounds (500, 50000 are domain limits).

## Verification

- `npx tsc --noEmit`: Clean
- `npx vitest run`: 1191 pass, 2 fail (pre-existing: state-reader, recovery — confirmed failing on master before changes)
- `node build.ts`: Clean, all 8 entry points built
- `desloppify show smells --status open`: **0 findings**
- `desloppify scan`: 10 resolved by scan, 15 resolved as wontfix. Objective score 96.4.

## Decisions Made

- **Named constants over inline expressions**: Extracted `MS_PER_DAY`, `STALE_LOCK_MS`, `METRICS_STALENESS_MS`, `MAX_REASONING_CHARS` to make intent explicit.
- **Sub-object extraction over per-access assertions**: In config.ts, extracted `hDef = defaults.hologram!` once rather than asserting 17 times.
- **Local variable narrowing over assertion chains**: In user-prompt-submit.ts and context-assembler.ts, used `const pos = gsdState?.position` and `const hologram = sources.hologram` to let TypeScript narrow naturally.
- **Explicit comparators over default sort**: Added `localeCompare` even though default lexicographic sort was correct, to make intent unambiguous.
- **Rename over consolidation for signature variance**: Renamed writer.ts's `estimateTokens` to `estimateCheckpointTokens` since it takes a different input type (Checkpoint vs string) by design.
