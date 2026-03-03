# Roadmap: Claudex Desloppify

## Overview

Systematic code quality cleanup of Claudex v2, driven by a desloppify scan (306 findings, strict score 69.6, target 95). Starts with the critical security finding, then leverages auto-fixers for 53% of findings, followed by manual cleanup of dead exports, structural reorganization, code smell resolution, and a final subjective review pass. Each phase rescans to verify progress and catch cascading issues.

## Phases

- [ ] **Phase 1: Security Review** - Review and resolve 1 security finding (2026-02-27)
- [ ] **Phase 2: Auto-Fixers** - Run desloppify auto-fixers for unused imports/vars, dead exports, debug logs (~90 findings)
- [ ] **Phase 3: Dead Exports Cleanup** - Manually remove remaining dead exports not handled by auto-fixers
- [ ] **Phase 4: Structural + Orphaned Files** - Decompose large files + delete/relocate 55 orphaned files (~76 findings)
- [ ] **Phase 5: Code Smells** - Resolve signature variance, complexity, and pattern findings (~72 findings)
- [ ] **Phase 6: Subjective Review + Final Scan** - Address subjective review findings, run final rescan for score >= 95

## Phase Details

### Phase 1: Security Review
**Goal**: Review and resolve the 1 open security finding
**Depends on**: Nothing (first phase)
**Requirements**: SEC-01
**Success Criteria** (what must be TRUE):
  1. Security finding reviewed with `desloppify show security --status open`
  2. Finding is either fixed in code, or documented as wontfix with rationale
  3. Rescan shows 0 open security findings
**Plans**: 1 plan
Plans:
- [ ] 01-01-PLAN.md -- Review security finding, assess severity, fix or document

### Phase 2: Auto-Fixers
**Goal**: Run all available desloppify auto-fixers to resolve ~90 findings automatically
**Depends on**: Phase 1
**Requirements**: AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05
**Success Criteria** (what must be TRUE):
  1. `desloppify fix unused-imports` applied (dry-run first, then apply)
  2. `desloppify fix unused-vars` applied
  3. `desloppify fix dead-exports --dry-run` reviewed, safe subset applied
  4. `desloppify fix debug-logs` applied
  5. All tests pass, tsc clean, build clean after fixes
  6. Rescan shows reduced finding count
**Plans**: 1 plan
Plans:
- [ ] 02-01-PLAN.md -- Run all auto-fixers (dry-run, review, apply, verify)

### Phase 3: Dead Exports Cleanup
**Goal**: Manually remove remaining dead exports not handled by auto-fixers
**Depends on**: Phase 2
**Requirements**: DEXP-01, DEXP-02
**Success Criteria** (what must be TRUE):
  1. All remaining export findings from `desloppify show exports --status open` resolved
  2. Each removed export verified to have no consumers (grep/find confirms)
  3. All tests pass, tsc clean, build clean
  4. Rescan shows 0 open export findings
**Plans**: 1 plan
Plans:
- [ ] 03-01-PLAN.md -- Audit remaining dead exports, remove unused, re-wire if needed

### Phase 4: Structural + Orphaned Files
**Goal**: Decompose large files (21 structural findings) and delete/relocate orphaned files (55 findings)
**Depends on**: Phase 3
**Requirements**: STRUC-01, STRUC-02, STRUC-03
**Success Criteria** (what must be TRUE):
  1. Structural findings resolved: large files split into focused modules
  2. Orphaned files either deleted (if truly dead) or relocated with imports updated
  3. No import breakage -- all tests pass, tsc clean, build clean
  4. Rescan shows 0 open structural and orphaned findings
**Plans**: 2 plans
Plans:
- [ ] 04-01-PLAN.md -- Resolve structural findings (decompose large files)
- [ ] 04-02-PLAN.md -- Resolve orphaned files (delete dead files, relocate live ones)

### Phase 5: Code Smells
**Goal**: Resolve signature variance, complexity, and pattern findings (~72 findings)
**Depends on**: Phase 4
**Requirements**: SMELL-01, SMELL-02, SMELL-03, SMELL-04
**Success Criteria** (what must be TRUE):
  1. Signature variance findings resolved (consistent function signatures)
  2. Complexity findings resolved (long functions decomposed)
  3. Pattern consistency findings resolved
  4. All tests pass, tsc clean, build clean
  5. Rescan shows 0 open smell findings
**Plans**: 1 plan
Plans:
- [ ] 05-01-PLAN.md -- Audit and resolve code smell findings by category

### Phase 6: Subjective Review + Final Scan
**Goal**: Address subjective review findings and achieve strict score >= 95
**Depends on**: Phase 5
**Requirements**: SUBJ-01, SUBJ-02, SUBJ-03
**Success Criteria** (what must be TRUE):
  1. Subjective review findings addressed (62 findings)
  2. Final `desloppify scan` shows strict score >= 95
  3. All tests pass (`vitest run`), tsc clean (`tsc --noEmit`), build clean (`node build.ts`)
  4. No regressions from any phase
**Plans**: 1 plan
Plans:
- [ ] 06-01-PLAN.md -- Address subjective review findings + run final rescan

## Progress

**Execution Order:**
Phases execute in order: 1 -> 2 -> 3 -> 4 -> 5 -> 6

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Security Review | 0/1 | Pending | — |
| 2. Auto-Fixers | 0/1 | Pending | — |
| 3. Dead Exports Cleanup | 0/1 | Pending | — |
| 4. Structural + Orphaned Files | 0/2 | Pending | — |
| 5. Code Smells | 0/1 | Pending | — |
| 6. Subjective Review + Final Scan | 0/1 | Pending | — |
