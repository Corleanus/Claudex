---
phase: "Phase 2: Live Validation"
status: blocked
blocked_by: Phase 1
---

# Phase 2 Context: Live Validation

## What We're Doing

Run the skill against real diffs. Validate:
1. Codex returns usable output for all 4 prompts
2. Synthesis correctly merges and deduplicates
3. Report is readable and actionable
4. Quality JSON imports into desloppify

## Test Plan

1. Make some uncommitted changes in Claudex codebase
2. Run `/unified-review`
3. Check each Codex perspective produced structured output
4. Verify synthesis report format matches spec
5. Run `desloppify review --import` with quality JSON
6. Adjust prompts if Codex output doesn't match expected format
