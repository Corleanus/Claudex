---
phase: "Phase 1: Skill Core"
status: ready
---

# Phase 1 Context: Skill Core

## What We're Building

Two files:
1. `~/.claude/skills/unified-review/SKILL.md` — main orchestration skill
2. `~/.claude/skills/unified-review/prompts.md` — 4 prompt templates

## Key Design Decisions

### Engine: MCP Codex (mcp__codex__codex)
All 4 reviews use `mcp__codex__codex` with `sandbox: "read-only"` and `approval-policy: "never"`. Not CLI codex — MCP works within Claude Code's tool system without install dependency.

### Parallel Dispatch
The 4 Codex calls are independent. Issue all 4 as parallel `mcp__codex__codex` calls in one response. Each gets a different prompt but same cwd and scope.

### Prompt Templates in Separate File
SKILL.md orchestrates. prompts.md holds the 4 large prompt templates. Keeps SKILL.md scannable.

### Scope Resolution
- Default: uncommitted changes (`git diff HEAD`)
- Branch diff: `git diff <branch>...HEAD`
- Specific commit: `git diff <sha>~1..<sha>`
- Arguments: `/unified-review [uncommitted|branch|commit <sha>]`

### Report Format
3-tier severity (Critical / Recommended / Observations) with overall letter grade (A-F). Each finding tagged with source perspective [QUALITY], [ACCEPTANCE], [SECURITY], [OPINION].

### Desloppify Compatibility
Quality perspective MUST output:
```json
{
  "assessments": {
    "naming_quality": N,
    "error_consistency": N,
    "abstraction_fitness": N,
    "logic_clarity": N,
    "ai_generated_debt": N,
    "type_safety": N,
    "contract_coherence": N
  },
  "findings": []
}
```

### Graceful Degradation
If any Codex call fails: synthesize from available perspectives, report which were unavailable, never block on a single failure.

## Reference Skills (read these for patterns)

- `~/.claude/skills/tob-second-opinion/SKILL.md` — scope detection, parallel external reviews
- `~/.claude/skills/tob-differential-review/SKILL.md` — security methodology, risk classification
- `~/.claude/skills/codex-review/SKILL.md` — Codex invocation patterns
- `~/.claude/skills/desloppify/SKILL.md` — subjective review flow, import format

## MCP Codex Interface

```
mcp__codex__codex({
  prompt: "...",
  cwd: "/path/to/project",
  sandbox: "read-only",
  approval-policy: "never"
})
```

Returns: Codex conversation output as text.
