# Phase 2: Auto-Fixers — Context

## Goal
Run all available desloppify auto-fixers to resolve ~90 findings automatically.

## Starting State
- 15 unused findings (imports, vars, params)
- 75 export findings (partial auto-fix via dead-exports)
- 1 log finding (debug-logs)
- 72 smell findings (partial auto-fix via dead-useeffect, empty-if-chain)

## Available Fixers
1. `desloppify fix unused-imports` — 15 findings
2. `desloppify fix unused-vars` — 15 findings
3. `desloppify fix unused-params` — 15 findings
4. `desloppify fix dead-exports` — 75 findings (partial)
5. `desloppify fix debug-logs` — 1 finding
6. `desloppify fix dead-useeffect` — 72 findings (partial)
7. `desloppify fix empty-if-chain` — 72 findings (partial)

## Approach
For each fixer:
1. Run with `--dry-run` to preview changes
2. Review output for safety (no behavior changes)
3. Apply the fix
4. Run `vitest run`, `tsc --noEmit`, `node build.ts` to verify
5. Rescan to confirm findings resolved

## Success Criteria
- AUTO-01 through AUTO-05: All auto-fixable findings resolved, no regressions
