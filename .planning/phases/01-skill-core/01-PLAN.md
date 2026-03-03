---
phase: 1
plan: 1
title: "Unified Review Skill Core"
wave: 1
depends_on: []
files_modified:
  - ~/.claude/skills/unified-review/SKILL.md
  - ~/.claude/skills/unified-review/prompts.md
requirements: [REV-01, REV-02, REV-03, REV-04, REV-05, REV-06, REV-07, REV-08, REV-09, REV-10, REV-11]
autonomous: true
---

# Plan 01: Unified Review Skill Core

## Objective

Create the complete unified-review skill: SKILL.md with orchestration logic and prompts.md with 4 perspective-specific prompt templates for Codex MCP dispatch.

## Tasks

<task id="T01" title="Create skill directory and SKILL.md">

Create `~/.claude/skills/unified-review/SKILL.md` with:

### Frontmatter

```yaml
---
name: unified-review
description: >
  Orchestrates 4-perspective code review (quality, acceptance, security, general)
  through Codex MCP, then synthesizes into a single severity-ranked report with
  letter grade. Use when the user asks for a unified review, full review,
  comprehensive review, or mentions /unified-review.
argument-hint: "[uncommitted|branch [base]|commit <sha>]"
user-invocable: true
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - mcp__codex__codex
---
```

### Skill Body Structure

The SKILL.md must contain these sections in order:

**1. Header + Purpose** — One-liner: "4 perspectives, 1 report." Explain what the skill does.

**2. When to Use / When NOT to Use** — Pattern from existing skills.

**3. Quick Reference** — Show the 3 invocation patterns:
- `/unified-review` — uncommitted (default)
- `/unified-review branch` or `/unified-review branch develop` — branch diff
- `/unified-review commit abc123` — specific commit

**4. Invocation (Step 1): Scope Resolution** [REV-01]

Parse `$ARGUMENTS` for scope:
- No args or `uncommitted` -> `git diff HEAD` (staged + unstaged + untracked)
- `branch` -> `git diff $(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo main)...HEAD`
- `branch <base>` -> `git diff <base>...HEAD`
- `commit <sha>` -> `git diff <sha>~1..<sha>`

If arguments are ambiguous, ask via AskUserQuestion (single question with options: Uncommitted changes / Branch diff vs main / Specific commit).

**5. Diff Preview + Large Diff Warning** [REV-11]

Run `git diff --stat <scope>`. If empty, stop. If >2000 lines changed, warn and ask whether to proceed or narrow scope.

**6. Dispatch (Step 2): 4 Parallel Codex Calls** [REV-06]

Read prompts.md (Read tool). Extract 4 prompt templates. Assemble each with:
- The resolved diff (inline the `git diff <scope>` output into the prompt, or instruct Codex to run the git diff itself)
- The cwd

Issue all 4 `mcp__codex__codex` calls in parallel in one response:

```
mcp__codex__codex({
  prompt: "<quality prompt from prompts.md, with scope instructions>",
  cwd: "<project root>",
  sandbox: "read-only",
  approval-policy: "never"
})
```

Repeat for acceptance, security, general — all 4 in parallel.

**Strategy for passing the diff to Codex:**
Instruct each Codex session to run the git diff command itself (since sandbox is read-only, git commands work). The prompt tells Codex: "Run `git diff <scope>` to see the changes, then review them."

This avoids pasting potentially huge diffs into the prompt and lets Codex navigate the codebase.

**7. Graceful Degradation** [REV-10]

After all 4 calls return (or fail):
- Collect successful results into an array
- Track which perspectives failed and why
- If ALL fail: report error, stop
- If SOME fail: proceed with available perspectives, note gaps in report header

**8. Synthesis (Step 3): Deduplicate + Classify** [REV-07]

From all successful Codex outputs:
1. Parse findings from each perspective
2. Deduplicate: same file + same line range + same issue = merge, tag with all source perspectives
3. Classify each finding into severity tier:
   - **Critical** — Security vulnerabilities, data loss risks, correctness bugs that affect users
   - **Recommended** — Logic improvements, missing edge cases, style violations with impact
   - **Observations** — Minor style, naming, documentation suggestions
4. Sort within each tier by file path

**9. Report Generation (Step 4)** [REV-08]

Write report to `./UNIFIED_REVIEW_REPORT.md`:

```markdown
# Unified Code Review Report

**Scope:** <scope description>
**Date:** <timestamp>
**Grade:** <A-F>
**Perspectives:** Quality [OK], Acceptance [OK], Security [FAILED], General [OK]

## Grading Rubric

| Grade | Criteria |
|-------|----------|
| A | No critical, <=2 recommended |
| B | No critical, 3-5 recommended |
| C | No critical, 6+ recommended OR 1 critical |
| D | 2-3 critical |
| F | 4+ critical |

---

## Critical

### [SECURITY][ACCEPTANCE] SQL injection in user input handler
**File:** src/db/queries.ts:45
**Issue:** User input passed directly to query template without parameterization.
**Recommendation:** Use parameterized queries.

---

## Recommended

### [QUALITY] Naming inconsistency in auth module
**File:** src/auth/session.ts:12
...

---

## Observations

### [OPINION] Consider extracting helper for repeated pattern
**File:** src/utils/format.ts:88
...

---

## Quality Scores (desloppify-compatible)

<json block — see below>
```

**10. Desloppify Quality Export** [REV-09]

Extract the quality perspective's dimension scores. Write `./unified_review_quality.json`:

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
  "findings": [
    {
      "id": "quality-001",
      "dimension": "naming_quality",
      "file": "src/auth/session.ts",
      "line": 12,
      "severity": "medium",
      "description": "..."
    }
  ]
}
```

Display: "Quality scores exported to ./unified_review_quality.json — import with: `desloppify review --import unified_review_quality.json`"

**11. Grade Calculation**

Based on the severity tier counts:
- A: 0 critical, <=2 recommended
- B: 0 critical, 3-5 recommended
- C: 0 critical, 6+ recommended OR 1 critical
- D: 2-3 critical
- F: 4+ critical

**12. Final Output**

Display report summary to chat (not the full file). Show:
- Grade with justification
- Critical findings (full)
- Recommended count + top 3
- Observation count
- Perspective coverage (which succeeded/failed)
- File paths for report and quality JSON

</task>

<task id="T02" title="Create prompts.md with 4 perspective templates">

Create `~/.claude/skills/unified-review/prompts.md` with 4 structured prompt templates.

Each prompt template follows this structure:
- Role definition
- What to examine
- How to report findings (structured format for machine parsing)
- Scope instruction placeholder: `{SCOPE_COMMAND}` — replaced at dispatch time with the actual git diff command

### Prompt 1: Quality Perspective [REV-02]

```markdown
## Quality Perspective Prompt

You are a code quality reviewer. Your job is to evaluate code changes across 7 dimensions and produce scores (0-100) with evidence.

### Scope

Run `{SCOPE_COMMAND}` to see the changes being reviewed.
Browse the surrounding codebase as needed for context.

### Dimensions to Score

For each dimension, examine the changed files and score 0-100:

1. **naming_quality** — Are names descriptive, consistent, following project conventions? Do variables/functions/classes communicate their purpose?
2. **error_consistency** — Is error handling consistent? Are errors propagated properly? Are error messages helpful? Is try/catch used appropriately?
3. **abstraction_fitness** — Are abstractions at the right level? Is there over-engineering or under-abstraction? Do interfaces fit their purpose?
4. **logic_clarity** — Is the logic easy to follow? Are there unnecessary complications? Could conditions be simplified?
5. **ai_generated_debt** — Does this look like AI-generated code that was accepted without refinement? Signs: generic variable names, over-commenting, unnecessary abstractions, boilerplate that doesn't fit the project style.
6. **type_safety** — Are types used effectively? Are there `any` types, unsafe casts, missing null checks? Is the type system leveraged for correctness?
7. **contract_coherence** — Do public interfaces/APIs make sense together? Are function signatures consistent? Do return types match expectations?

### Output Format

You MUST output a JSON block wrapped in ```json fences at the END of your response:

\```json
{
  "assessments": {
    "naming_quality": <0-100>,
    "error_consistency": <0-100>,
    "abstraction_fitness": <0-100>,
    "logic_clarity": <0-100>,
    "ai_generated_debt": <0-100>,
    "type_safety": <0-100>,
    "contract_coherence": <0-100>
  },
  "findings": [
    {
      "id": "quality-NNN",
      "dimension": "<dimension_name>",
      "file": "<relative path>",
      "line": <line number>,
      "severity": "low|medium|high",
      "description": "<what and why>"
    }
  ]
}
\```

Before the JSON, provide a brief narrative explaining your scores per dimension. Reference specific files and lines.
```

### Prompt 2: Acceptance Perspective [REV-03]

```markdown
## Acceptance Perspective Prompt

You are an acceptance reviewer focused on correctness. Your job is to verify that the code does what it claims to do, handles edge cases, and fulfills its contract.

### Scope

Run `{SCOPE_COMMAND}` to see the changes being reviewed.
Read surrounding code, tests, and documentation for context.

### Review Checklist

1. **Correctness** — Does the code produce correct results for normal inputs? Are algorithms implemented correctly?
2. **Edge Cases** — What happens with empty inputs, null values, boundary values, concurrent access, large inputs?
3. **Logic Bugs** — Off-by-one errors, incorrect boolean logic, missing break/return, wrong comparison operators
4. **Contract Fulfillment** — Do functions deliver what their signature/docs promise? Are preconditions checked? Are postconditions met?
5. **Error Paths** — What happens when dependencies fail? Are errors caught and handled? Can the system recover?
6. **Regression Risk** — Could these changes break existing behavior? Are assumptions from callers still valid?

### Output Format

For each finding, report:

**FINDING-ACC-NNN**
- **File:** <path>:<line>
- **Severity:** critical | recommended | observation
- **Category:** correctness | edge-case | logic-bug | contract | error-path | regression
- **Issue:** <description>
- **Evidence:** <code snippet or reasoning>
- **Recommendation:** <specific fix>

End with a summary: total findings by severity, overall assessment of change safety.
```

### Prompt 3: Security Perspective [REV-04]

```markdown
## Security Perspective Prompt

You are a security reviewer performing differential analysis. Your job is to find security vulnerabilities, regressions, and risks introduced or exposed by the changes.

### Scope

Run `{SCOPE_COMMAND}` to see the changes being reviewed.
Examine the broader codebase for context: auth flows, data validation, external calls.

### Analysis Areas

1. **Input Validation** — Are all external inputs validated? Can malformed data reach sensitive operations? Injection vectors (SQL, XSS, command, path traversal)?
2. **Authentication & Authorization** — Are auth checks present and correct? Can they be bypassed? Are permissions verified before actions?
3. **Cryptography** — Are crypto operations correct? Hardcoded keys/secrets? Weak algorithms? Proper randomness?
4. **Data Exposure** — Are sensitive data (PII, credentials, tokens) properly protected? Logged? Exposed in errors?
5. **External Calls** — Are external services called safely? Timeouts set? Responses validated? SSRF risks?
6. **Blast Radius** — How many callers are affected? What's the worst case if this code is exploited?
7. **Removed Security Code** — Was any validation, sanitization, or auth check removed? Check git blame for security-related commits.

### Output Format

For each finding, report:

**FINDING-SEC-NNN**
- **File:** <path>:<line>
- **Severity:** critical | recommended | observation
- **Category:** injection | auth | crypto | data-exposure | external | blast-radius | regression
- **Issue:** <description>
- **Attack Scenario:** <concrete exploit path, not generic>
- **Recommendation:** <specific mitigation>

End with:
- Security posture assessment (improved / unchanged / degraded)
- Blast radius estimate (files/functions affected)
- Confidence level (high/medium/low) with stated limitations
```

### Prompt 4: General (Fresh Eyes) Perspective [REV-05]

```markdown
## General Perspective Prompt

You are a senior developer seeing this code for the first time. Your job is to provide a fresh-eyes review: what stands out, what's confusing, what could be improved.

### Scope

Run `{SCOPE_COMMAND}` to see the changes being reviewed.
Read surrounding code for context, but don't try to understand the entire codebase — review as an outsider would.

### Review Focus

1. **First Impressions** — What's unclear? What would confuse a new team member?
2. **Architecture Fit** — Do these changes fit the project's patterns? Or do they introduce inconsistencies?
3. **Maintainability** — Will this be easy to modify later? Are there implicit dependencies or magic values?
4. **Testing** — Are the changes testable? Are tests present and meaningful? What's missing?
5. **Documentation** — Are complex decisions explained? Are public APIs documented?
6. **Performance** — Any obvious inefficiencies? N+1 queries, unnecessary allocations, missing caching opportunities?
7. **Anything Else** — What catches your eye that doesn't fit the above categories?

### Output Format

For each finding, report:

**FINDING-GEN-NNN**
- **File:** <path>:<line>
- **Severity:** critical | recommended | observation
- **Category:** clarity | architecture | maintainability | testing | docs | performance | other
- **Issue:** <description>
- **Recommendation:** <suggestion>

End with a 2-3 sentence overall impression: what's the strongest aspect, what's the weakest, one thing to fix first.
```

</task>

## Verification Criteria

- [ ] `~/.claude/skills/unified-review/SKILL.md` exists with valid frontmatter (name, description, allowed-tools including mcp__codex__codex)
- [ ] `~/.claude/skills/unified-review/prompts.md` exists with 4 distinct prompt templates
- [ ] SKILL.md handles scope resolution: uncommitted (default), branch diff, specific commit [REV-01]
- [ ] SKILL.md includes large diff warning >2000 lines [REV-11]
- [ ] Quality prompt scores all 7 desloppify dimensions with 0-100 scores [REV-02]
- [ ] Quality prompt outputs JSON matching `{"assessments": {...}, "findings": [...]}` [REV-09]
- [ ] Acceptance prompt covers correctness, edge cases, logic bugs, contracts [REV-03]
- [ ] Security prompt covers injection, auth, crypto, data exposure, blast radius [REV-04]
- [ ] General prompt provides fresh-eyes review across clarity, architecture, testing [REV-05]
- [ ] All 4 dispatched via `mcp__codex__codex` with `sandbox: "read-only"` and `approval-policy: "never"` [REV-06]
- [ ] Synthesis deduplicates and classifies into Critical/Recommended/Observations [REV-07]
- [ ] Report includes grade (A-F), severity sections, perspective tags [REV-08]
- [ ] Graceful degradation handles partial Codex failures [REV-10]

## must_haves

Derived from phase goal — non-negotiable outcomes:

1. SKILL.md orchestrates 4 parallel Codex reviews from a single invocation
2. prompts.md contains 4 complete, structured prompt templates with machine-parseable output formats
3. Quality JSON output is byte-compatible with `desloppify review --import`
4. Report uses 3-tier severity with perspective source tags
5. Partial failures produce partial reports, not total failures
