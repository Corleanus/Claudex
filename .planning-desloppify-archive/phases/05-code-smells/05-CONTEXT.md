# Phase 5: Code Smells — Context

## Goal
Resolve 72 code smell findings covering signature variance, complexity, and pattern consistency.

## Starting State
- 72 smell findings (post-Phase 2 auto-fix count may be lower)
- Smells dimension: 83.3% pass rate (64 checks, 25 issues at scan time with noise budget hiding 62)
- Command: `desloppify show smells --status open`

## Approach
1. List remaining smell findings with `desloppify show smells --status open`
2. Group by subcategory (signature variance, complexity, patterns)
3. For each group:
   a. Assess the pattern — what's the consistent fix?
   b. Apply fixes batch-by-batch
   c. Verify tests pass between batches
4. Rescan to confirm 0 open smell findings

## Success Criteria
- SMELL-01: Signature variance resolved
- SMELL-02: Complexity resolved
- SMELL-03: Pattern consistency resolved
- SMELL-04: Rescan confirms 0 open smell findings
