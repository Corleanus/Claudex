# Requirements: Unified Code Review Skill

**Defined:** 2026-02-28
**Core Value:** One command, one report, four perspectives — complete code review coverage without tool fragmentation.

## v1 Requirements

### Scope Resolution

- [ ] **REV-01**: Skill resolves review scope (uncommitted, branch diff, commit) from arguments or interactive prompt
- [ ] **REV-11**: Large diff warning (>2000 lines) with option to narrow scope

### Review Perspectives

- [ ] **REV-02**: Quality perspective scores 7 desloppify dimensions (0-100) with evidence per dimension
- [ ] **REV-03**: Acceptance perspective checks correctness, logic bugs, edge cases, contract fulfillment
- [ ] **REV-04**: Security perspective analyzes auth, crypto, validation, blast radius, regressions
- [ ] **REV-05**: General perspective provides fresh-eyes catch-all review
- [ ] **REV-06**: All 4 perspectives dispatched through mcp__codex__codex with structured prompts

### Synthesis & Output

- [ ] **REV-07**: Synthesis deduplicates findings across perspectives and classifies by severity (Critical/Recommended/Observations)
- [ ] **REV-08**: Output is a single markdown report with overall grade (A-F), severity sections, and source perspective tags
- [ ] **REV-09**: Quality perspective output compatible with desloppify review --import JSON format
- [ ] **REV-10**: Graceful degradation — if any Codex call fails, synthesize from available perspectives and report gaps

## v2 Requirements

### Multi-Engine

- **REV-V2-01**: Gemini CLI as alternative/additional review engine
- **REV-V2-02**: Run both Codex and Gemini for cross-model diversity

### Integration

- **REV-V2-03**: Auto-import quality scores to desloppify after review
- **REV-V2-04**: CI/CD integration (GitHub Actions trigger)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Replace desloppify mechanical scanning | Deterministic Python analysis is faster and more reliable |
| Auto-fix capabilities | Review only — fixing is a separate concern |
| Replace individual review skills | They serve standalone use cases |
| Spec-kitty integration | v1 is project-management agnostic |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REV-01 | Phase 1 | Pending |
| REV-02 | Phase 1 | Pending |
| REV-03 | Phase 1 | Pending |
| REV-04 | Phase 1 | Pending |
| REV-05 | Phase 1 | Pending |
| REV-06 | Phase 1 | Pending |
| REV-07 | Phase 1 | Pending |
| REV-08 | Phase 1 | Pending |
| REV-09 | Phase 1 | Pending |
| REV-10 | Phase 1 | Pending |
| REV-11 | Phase 1 | Pending |

**Coverage:**
- v1 requirements: 11 total
- Mapped to phases: 11
- Unmapped: 0

---
*Requirements defined: 2026-02-28*
*Last updated: 2026-02-28 after initial definition*
