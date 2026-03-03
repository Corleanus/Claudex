# Claudex Desloppify

## What This Is

A systematic code quality cleanup of the Claudex v2 codebase, driven by a desloppify scan that found 306 findings across 10 detectors. The goal is to bring the strict score from 69.6 to 95+ by resolving dead exports, code smells, orphaned files, structural issues, unused code, and security findings.

## Core Value

Clean, maintainable codebase with no dead exports, no orphaned files, no security issues, and a strict desloppify score at or above the 95 target.

## Requirements

### Validated

(None yet -- ship to validate)

### Active

- [ ] Security finding reviewed and resolved (1 finding)
- [ ] All auto-fixable findings resolved via desloppify fixers (~90 findings: unused imports/vars, auto-fixable dead exports, debug logs)
- [ ] Remaining dead exports manually cleaned up (~75 total, minus auto-fixed)
- [ ] Structural issues resolved (21 findings: large files decomposed)
- [ ] Orphaned files deleted or relocated (55 findings)
- [ ] Code smells addressed (72 findings: signature variance, complexity, patterns)
- [ ] Subjective review findings addressed (62 findings)
- [ ] Final rescan confirms strict score >= 95
- [ ] All tests pass, tsc clean, build clean after each phase

### Out of Scope

- New features or functionality changes
- Refactoring beyond what findings require
- Test coverage findings (3 findings -- tracked but deferred unless trivial)
- Duplication finding (1 finding -- tracked but deferred unless trivial)
- Changes to hook deployment or runtime behavior
- Hologram sidecar changes

## Context

- Claudex v2 GSD Integration milestone COMPLETE. 1207 tests, build clean, tsc clean.
- Desloppify scan: 306 findings, strict score 69.6 (target 95)
- Breakdown: dead exports (75), smells (72), subjective review (62), orphaned (55), structural (21), unused (15), test coverage (3), security (1), dupes (1), logs (1)
- 163 findings are auto-fixable (53% coverage)
- Scan results in `.desloppify/query.json`

## Constraints

- **No behavior changes**: Cleanup only -- all tests must continue passing
- **Phase-by-phase**: Each phase rescans to verify progress and catch cascading findings
- **Dry-run first**: All auto-fixers run with --dry-run before applying
- **Scope lock**: Don't fix things not flagged by the scan

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Security first | 1 open security finding must be reviewed before bulk cleanup | Pending |
| Auto-fixers before manual | 53% of findings are auto-fixable, reducing manual work | Pending |
| Dead exports separate phase | 75 findings is the largest category, needs focused attention | Pending |
| Structural + orphaned together | Both involve file-level reorganization, natural pairing | Pending |
| Subjective review last | Lowest priority tier, may resolve naturally from earlier fixes | Pending |

---
*Last updated: 2026-02-27 after initialization*
