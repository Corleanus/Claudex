# Unified Code Review Skill

## What This Is

A Claude Code skill (`/unified-review`) that orchestrates 4 review perspectives through Codex MCP, then synthesizes findings into one severity-ranked, deduplicated report. Replaces running 4 separate review tools and mentally merging results.

## Core Value

One command, one report, four perspectives — complete code review coverage without tool fragmentation.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] REV-01: Skill resolves review scope (uncommitted, branch diff, commit) from arguments or interactive prompt
- [ ] REV-02: Quality perspective scores 7 desloppify dimensions (0-100) with evidence per dimension
- [ ] REV-03: Acceptance perspective checks correctness, logic bugs, edge cases, contract fulfillment
- [ ] REV-04: Security perspective analyzes auth, crypto, validation, blast radius, regressions
- [ ] REV-05: General perspective provides fresh-eyes catch-all review
- [ ] REV-06: All 4 perspectives dispatched through mcp__codex__codex with structured prompts
- [ ] REV-07: Synthesis deduplicates findings across perspectives and classifies by severity (Critical/Recommended/Observations)
- [ ] REV-08: Output is a single markdown report with overall grade (A-F), severity sections, and source perspective tags
- [ ] REV-09: Quality perspective output compatible with desloppify review --import JSON format
- [ ] REV-10: Graceful degradation — if any Codex call fails, synthesize from available perspectives and report gaps
- [ ] REV-11: Large diff warning (>2000 lines) with option to narrow scope

### Out of Scope

- Replacing desloppify mechanical scanning — deterministic Python analysis stays separate
- Replacing individual review skills — they continue to exist for standalone use
- Gemini CLI integration — Codex MCP only for v1
- Auto-fix capabilities — review only, no code modification
- CI/CD integration — manual invocation only for v1

## Context

Existing review skills being unified:
1. **desloppify** subjective review — review --prepare -> Claude subagent -> review --import. 7 dimensions, blind review on sampled files.
2. **codex-review** — codex exec --full-auto with spec-kitty prompts. Tightly coupled to spec-kitty WP workflow.
3. **tob-differential-review** — 6-phase security review (triage -> analysis -> coverage -> blast radius -> adversarial -> report). Multi-file Claude workflow.
4. **tob-second-opinion** — shells out to codex review CLI or gemini -p. Parallel external reviews.

Key interfaces:
- mcp__codex__codex MCP tool: prompt, cwd, sandbox ("read-only"), approval-policy ("never")
- desloppify review --import <file>: expects {"assessments": {...}, "findings": [...]}

## Constraints

- **Engine**: Must use mcp__codex__codex MCP tool (not CLI codex)
- **Sandbox**: All reviews read-only (sandbox: "read-only")
- **Output location**: Skill at ~/.claude/skills/unified-review/SKILL.md
- **Compatibility**: Quality scores must match desloppify import format exactly

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| MCP Codex over CLI Codex | Works within Claude Code tool system, no CLI install dependency | -- Pending |
| 4 parallel Codex sessions | Reviews are independent, parallel maximizes speed | -- Pending |
| Prompt templates in separate file | Keeps SKILL.md lean, prompts are large | -- Pending |
| Read-only sandbox for all | Reviews don't need file writes | -- Pending |

---
*Last updated: 2026-02-28 after initialization*
