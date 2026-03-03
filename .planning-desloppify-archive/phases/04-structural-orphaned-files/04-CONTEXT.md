# Phase 4: Structural + Orphaned Files — Context

## Goal
Decompose large files (21 structural findings) and delete/relocate orphaned files (55 findings). ~76 findings total.

## Starting State
- 21 structural findings (large files needing decomposition)
- 55 orphaned files (unreferenced files)
- Commands: `desloppify show structural --status open`, `desloppify show orphaned --status open`

## Approach

### Plan 1: Structural (04-01)
1. List structural findings with `desloppify show structural --status open`
2. For each large file:
   a. Identify logical boundaries for extraction
   b. Extract into focused modules
   c. Update imports across codebase
   d. Verify with tsc + tests
3. Rescan structural dimension

### Plan 2: Orphaned Files (04-02)
1. List orphaned files with `desloppify show orphaned --status open`
2. Categorize: truly dead (delete) vs misclassified (relocate or mark false_positive)
3. For dead files: delete and verify no breakage
4. For misclassified: use `desloppify move` or mark as false_positive
5. Rescan orphaned dimension

## Success Criteria
- STRUC-01: Large files decomposed
- STRUC-02: Orphaned files resolved
- STRUC-03: Rescan confirms 0 open structural + orphaned findings
