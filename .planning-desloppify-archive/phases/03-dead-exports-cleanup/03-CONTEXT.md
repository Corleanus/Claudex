# Phase 3: Dead Exports Cleanup — Context

## Goal
Manually remove remaining dead exports not handled by the auto-fixer in Phase 2.

## Starting State
- Post-Phase 2 rescan will determine exact remaining count
- Original: 75 export findings, some auto-fixed in Phase 2

## Approach
1. Run `desloppify show exports --status open` to list remaining findings
2. For each dead export:
   a. Grep the codebase for consumers
   b. If truly unused: remove the `export` keyword (or the entire declaration if the symbol is also unused internally)
   c. If used but mis-detected: mark as false_positive
3. Verify with `tsc --noEmit` after each batch (catch broken imports early)
4. Run full test suite after all removals
5. Rescan to confirm 0 open export findings

## Success Criteria
- DEXP-01: All remaining dead exports removed or re-wired
- DEXP-02: Rescan confirms 0 open export findings
