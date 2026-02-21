/**
 * Claudex v2 -- GSD State Reader Tests
 *
 * TDD tests for src/gsd/state-reader.ts.
 * Covers parseStateMd, parseRoadmapMd, countPlanFiles, readGsdState,
 * and edge cases (CRLF, decimal phases, malformed input).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { GsdState, GsdCurrentPosition, GsdPhase, GsdPlanSummary } from '../../src/gsd/types.js';
import { EMPTY_GSD_STATE } from '../../src/gsd/types.js';

// Module under test -- will fail until state-reader.ts is created
import {
  readGsdState,
  parseStateMd,
  parseRoadmapMd,
  countPlanFiles,
  findActivePlanFile,
  extractPlanMustHaves,
  countCompletedRequirements,
} from '../../src/gsd/state-reader.js';

// =============================================================================
// Fixtures
// =============================================================================

const STATE_MD_FORMAT_A = `# Project State

## Current Position

Phase: 3 of 8 (Phase-Weighted Scoring)
Plan: 2 of 5 in current phase
Status: Executing plan

Progress: [###-------] 30%
`;

const STATE_MD_FORMAT_B = `# Project State

## Current Position

**Current Phase:** 3
**Current Phase Name:** Phase-Weighted Scoring
**Total Phases:** 8
**Current Plan:** 2
**Total Plans:** 5
**Status:** Executing plan
`;

const STATE_MD_TBD_PLANS = `# Project State

## Current Position

Phase: 1 of 8 (GSD State Reader)
Plan: 0 of TBD in current phase
Status: Ready to plan
`;

const ROADMAP_MD = `# Roadmap: My Project

## Phases

- [ ] **Phase 1: Foundation** - Build the base
- [ ] **Phase 2: Core Features** - Main functionality
- [x] **Phase 3: Polish** - UI polish

## Phase Details

### Phase 1: Foundation
**Goal**: Build a solid foundation for the project
**Depends on**: Nothing (first phase)
**Requirements**: PCTX-01, PCTX-02
**Success Criteria** (what must be TRUE):
  1. Database schema is defined and migrated
  2. Auth endpoints work with test credentials
  3. Basic API structure is in place
**Plans**: 2 plans

### Phase 2: Core Features
**Goal**: Implement the main user-facing features
**Depends on**: Phase 1
**Requirements**: FEAT-01
**Success Criteria** (what must be TRUE):
  1. User can create and manage items
  2. Search works across all fields
**Plans**: TBD

### Phase 3: Polish
**Goal**: Polish the UI and improve UX
**Depends on**: Phase 2
**Requirements**: None
**Success Criteria** (what must be TRUE):
  1. All pages are responsive
  2. Loading states are implemented
**Plans**: 1 plan
`;

const ROADMAP_MD_DECIMAL = `# Roadmap

## Phases

- [ ] **Phase 1: First**
- [ ] **Phase 2: Second**
- [ ] **Phase 2.1: Inserted Fix** (INSERTED)
- [ ] **Phase 3: Third**
- [ ] **Phase 10: Tenth**

## Phase Details

### Phase 1: First
**Goal**: First phase goal
**Requirements**: REQ-01

### Phase 2: Second
**Goal**: Second phase goal
**Depends on**: Phase 1
**Requirements**: REQ-02

### Phase 2.1: Inserted Fix
**Goal**: Emergency fix
**Depends on**: Phase 2
**Requirements**: REQ-02A

### Phase 3: Third
**Goal**: Third phase goal
**Depends on**: Phase 2.1
**Requirements**: REQ-03

### Phase 10: Tenth
**Goal**: Tenth phase goal
**Depends on**: Phase 3
**Requirements**: REQ-10
`;

// =============================================================================
// Test Helpers
// =============================================================================

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-'));
}

function writePlanningFiles(
  root: string,
  files: Record<string, string>,
  phaseDirs?: Record<string, string[]>,
): void {
  const planningDir = path.join(root, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(planningDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  if (phaseDirs) {
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    for (const [dirName, planFiles] of Object.entries(phaseDirs)) {
      const phaseDir = path.join(phasesDir, dirName);
      fs.mkdirSync(phaseDir, { recursive: true });
      for (const pf of planFiles) {
        fs.writeFileSync(path.join(phaseDir, pf), '# Plan content');
      }
    }
  }
}

function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// parseStateMd
// =============================================================================

describe('parseStateMd', () => {
  it('parses Format A (plain-text position)', () => {
    const result = parseStateMd(STATE_MD_FORMAT_A);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.totalPhases).toBe(8);
    expect(result!.phaseName).toBe('Phase-Weighted Scoring');
    expect(result!.plan).toBe(2);
    expect(result!.totalPlans).toBe(5);
    expect(result!.status).toBe('Executing plan');
  });

  it('parses Format B (structured fields)', () => {
    const result = parseStateMd(STATE_MD_FORMAT_B);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.totalPhases).toBe(8);
    expect(result!.phaseName).toBe('Phase-Weighted Scoring');
    expect(result!.plan).toBe(2);
    expect(result!.totalPlans).toBe(5);
    expect(result!.status).toBe('Executing plan');
  });

  it('parses TBD plan count as null', () => {
    const result = parseStateMd(STATE_MD_TBD_PLANS);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(1);
    expect(result!.totalPlans).toBeNull();
    expect(result!.plan).toBe(0);
  });

  it('returns null for empty input', () => {
    expect(parseStateMd('')).toBeNull();
  });

  it('returns null for garbage input', () => {
    expect(parseStateMd('random text with no structure')).toBeNull();
  });

  it('returns null for malformed content', () => {
    const malformed = `# Project State\n## Current Position\nPhase: broken`;
    expect(parseStateMd(malformed)).toBeNull();
  });

  it('handles CRLF line endings', () => {
    const crlf = STATE_MD_FORMAT_A.replace(/\n/g, '\r\n');
    const result = parseStateMd(crlf);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.phaseName).toBe('Phase-Weighted Scoring');
  });

  it('handles CRLF in Format B', () => {
    const crlf = STATE_MD_FORMAT_B.replace(/\n/g, '\r\n');
    const result = parseStateMd(crlf);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(3);
    expect(result!.phaseName).toBe('Phase-Weighted Scoring');
  });

  it('parses decimal phase numbers', () => {
    const decimal = `Phase: 2.1 of 10 (Inserted Phase)\nPlan: 1 of 3 in current phase\nStatus: Active`;
    const result = parseStateMd(decimal);
    expect(result).not.toBeNull();
    expect(result!.phase).toBe(2.1);
    expect(result!.totalPhases).toBe(10);
    expect(result!.phaseName).toBe('Inserted Phase');
  });
});

// =============================================================================
// parseRoadmapMd
// =============================================================================

describe('parseRoadmapMd', () => {
  it('extracts all phases with correct fields', () => {
    const phases = parseRoadmapMd(ROADMAP_MD);
    expect(phases).toHaveLength(3);

    expect(phases[0]!.number).toBe(1);
    expect(phases[0]!.name).toBe('Foundation');
    expect(phases[0]!.goal).toBe('Build a solid foundation for the project');
    expect(phases[0]!.dependsOn).toBe('Nothing (first phase)');
    expect(phases[0]!.requirements).toEqual(['PCTX-01', 'PCTX-02']);
    expect(phases[0]!.successCriteria).toHaveLength(3);
    expect(phases[0]!.roadmapComplete).toBe(false);

    expect(phases[1]!.number).toBe(2);
    expect(phases[1]!.name).toBe('Core Features');
    expect(phases[1]!.requirements).toEqual(['FEAT-01']);
    expect(phases[1]!.roadmapComplete).toBe(false);

    expect(phases[2]!.number).toBe(3);
    expect(phases[2]!.name).toBe('Polish');
    expect(phases[2]!.requirements).toEqual([]);
    expect(phases[2]!.roadmapComplete).toBe(true);
  });

  it('parses success criteria as clean text', () => {
    const phases = parseRoadmapMd(ROADMAP_MD);
    expect(phases[0]!.successCriteria[0]).toBe('Database schema is defined and migrated');
    expect(phases[0]!.successCriteria[1]).toBe('Auth endpoints work with test credentials');
    expect(phases[0]!.successCriteria[2]).toBe('Basic API structure is in place');
  });

  it('handles depends-on text', () => {
    const phases = parseRoadmapMd(ROADMAP_MD);
    expect(phases[0]!.dependsOn).toBe('Nothing (first phase)');
    expect(phases[1]!.dependsOn).toBe('Phase 1');
    expect(phases[2]!.dependsOn).toBe('Phase 2');
  });

  it('sorts decimal phases correctly', () => {
    const phases = parseRoadmapMd(ROADMAP_MD_DECIMAL);
    expect(phases.map(p => p.number)).toEqual([1, 2, 2.1, 3, 10]);
  });

  it('handles decimal phase names (strips INSERTED marker)', () => {
    const phases = parseRoadmapMd(ROADMAP_MD_DECIMAL);
    const phase21 = phases.find(p => p.number === 2.1);
    expect(phase21).toBeDefined();
    expect(phase21!.name).toBe('Inserted Fix');
  });

  it('returns empty array for empty input', () => {
    expect(parseRoadmapMd('')).toEqual([]);
  });

  it('returns empty array for garbage input', () => {
    expect(parseRoadmapMd('no phases here at all')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const crlf = ROADMAP_MD.replace(/\n/g, '\r\n');
    const phases = parseRoadmapMd(crlf);
    expect(phases).toHaveLength(3);
    expect(phases[0]!.name).toBe('Foundation');
  });

  it('filters out "None" and "TBD" from requirements', () => {
    const withNone = ROADMAP_MD.replace('**Requirements**: PCTX-01, PCTX-02', '**Requirements**: None');
    const phases = parseRoadmapMd(withNone);
    expect(phases[0]!.requirements).toEqual([]);
  });

  it('handles missing goal field', () => {
    const noGoal = `## Phase Details\n\n### Phase 1: NoGoal\n**Depends on**: Nothing\n**Requirements**: REQ-01`;
    const phases = parseRoadmapMd(noGoal);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.goal).toBeNull();
  });

  it('handles missing depends-on field', () => {
    const noDeps = `## Phase Details\n\n### Phase 1: NoDeps\n**Goal**: Something\n**Requirements**: REQ-01`;
    const phases = parseRoadmapMd(noDeps);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.dependsOn).toBeNull();
  });
});

// =============================================================================
// countPlanFiles
// =============================================================================

describe('countPlanFiles', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('counts plan and summary files', () => {
    const phaseDir = path.join(tmpDir, 'phase-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');

    const result = countPlanFiles(phaseDir);
    expect(result.total).toBe(2);
    expect(result.complete).toBe(1);
  });

  it('returns zero counts for empty directory', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const result = countPlanFiles(emptyDir);
    expect(result.total).toBe(0);
    expect(result.complete).toBe(0);
  });

  it('returns zero counts for missing directory', () => {
    const result = countPlanFiles(path.join(tmpDir, 'nonexistent'));
    expect(result.total).toBe(0);
    expect(result.complete).toBe(0);
  });

  it('handles bare PLAN.md and SUMMARY.md filenames', () => {
    const phaseDir = path.join(tmpDir, 'bare');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, 'SUMMARY.md'), '# Summary');

    const result = countPlanFiles(phaseDir);
    expect(result.total).toBe(1);
    expect(result.complete).toBe(1);
  });

  it('ignores non-plan markdown files', () => {
    const phaseDir = path.join(tmpDir, 'mixed');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-CONTEXT.md'), '# Context');
    fs.writeFileSync(path.join(phaseDir, '01-RESEARCH.md'), '# Research');
    fs.writeFileSync(path.join(phaseDir, 'README.md'), '# Readme');

    const result = countPlanFiles(phaseDir);
    expect(result.total).toBe(1);
    expect(result.complete).toBe(0);
  });
});

// =============================================================================
// readGsdState (integration)
// =============================================================================

describe('readGsdState', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('returns active state with correct position and phases', () => {
    writePlanningFiles(
      tmpDir,
      {
        'STATE.md': STATE_MD_FORMAT_A,
        'ROADMAP.md': ROADMAP_MD,
      },
      {
        '01-foundation': ['01-01-PLAN.md', '01-02-PLAN.md', '01-01-SUMMARY.md'],
        '02-core-features': ['02-01-PLAN.md'],
        '03-polish': ['03-01-PLAN.md', '03-01-SUMMARY.md'],
      },
    );

    const state = readGsdState(tmpDir);
    expect(state.active).toBe(true);
    expect(state.position).not.toBeNull();
    expect(state.position!.phase).toBe(3);
    expect(state.position!.phaseName).toBe('Phase-Weighted Scoring');
    expect(state.phases).toHaveLength(3);
  });

  it('returns active:false when no .planning/ directory', () => {
    const state = readGsdState(tmpDir);
    expect(state.active).toBe(false);
    expect(state.position).toBeNull();
    expect(state.phases).toEqual([]);
    expect(state.warnings).toEqual([]);
  });

  it('returns active:false when .planning/ exists but no STATE.md or ROADMAP.md', () => {
    const planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    const state = readGsdState(tmpDir);
    expect(state.active).toBe(false);
    expect(state.phases).toEqual([]);
  });

  it('still parses ROADMAP.md when STATE.md is malformed', () => {
    writePlanningFiles(tmpDir, {
      'STATE.md': 'totally broken content',
      'ROADMAP.md': ROADMAP_MD,
    });

    const state = readGsdState(tmpDir);
    // Active because ROADMAP has phases, even though position is null
    expect(state.active).toBe(true);
    expect(state.position).toBeNull();
    expect(state.phases).toHaveLength(3);
  });

  it('counts plan files per phase from disk', () => {
    writePlanningFiles(
      tmpDir,
      {
        'STATE.md': STATE_MD_TBD_PLANS,
        'ROADMAP.md': ROADMAP_MD,
      },
      {
        '01-foundation': ['01-01-PLAN.md', '01-02-PLAN.md', '01-01-SUMMARY.md'],
        '03-polish': ['03-01-PLAN.md', '03-01-SUMMARY.md'],
      },
    );

    const state = readGsdState(tmpDir);
    const phase1 = state.phases.find(p => p.number === 1);
    expect(phase1).toBeDefined();
    expect(phase1!.plans).not.toBeNull();
    expect(phase1!.plans!.total).toBe(2);
    expect(phase1!.plans!.complete).toBe(1);

    // Phase 2 has no directory
    const phase2 = state.phases.find(p => p.number === 2);
    expect(phase2).toBeDefined();
    expect(phase2!.plans).toBeNull();

    // Phase 3 has directory
    const phase3 = state.phases.find(p => p.number === 3);
    expect(phase3).toBeDefined();
    expect(phase3!.plans).not.toBeNull();
    expect(phase3!.plans!.total).toBe(1);
    expect(phase3!.plans!.complete).toBe(1);
  });

  it('generates cross-reference warnings when phases beyond current have plans', () => {
    writePlanningFiles(
      tmpDir,
      {
        'STATE.md': STATE_MD_TBD_PLANS, // Phase 1
        'ROADMAP.md': ROADMAP_MD,
      },
      {
        '01-foundation': ['01-01-PLAN.md'],
        '03-polish': ['03-01-PLAN.md', '03-01-SUMMARY.md'], // Beyond Phase 1
      },
    );

    const state = readGsdState(tmpDir);
    expect(state.warnings.length).toBeGreaterThan(0);
    expect(state.warnings.some(w => w.includes('3') || w.includes('Polish'))).toBe(true);
  });

  it('generates warning for disk directories not in ROADMAP', () => {
    writePlanningFiles(
      tmpDir,
      {
        'STATE.md': STATE_MD_TBD_PLANS,
        'ROADMAP.md': ROADMAP_MD, // Only phases 1, 2, 3
      },
      {
        '01-foundation': ['01-01-PLAN.md'],
        '99-unknown-phase': ['99-01-PLAN.md'], // Not in roadmap
      },
    );

    const state = readGsdState(tmpDir);
    // Phase count should only be 3 (from roadmap), not 4
    expect(state.phases).toHaveLength(3);
    // Should have a warning about the unknown directory
    expect(state.warnings.some(w => w.includes('99') || w.includes('unknown'))).toBe(true);
  });

  it('never throws on any error', () => {
    // Pass completely invalid paths
    expect(() => readGsdState('')).not.toThrow();
    expect(() => readGsdState('/nonexistent/path/to/nowhere')).not.toThrow();

    const result = readGsdState('');
    expect(result).toEqual(expect.objectContaining({ active: false }));
  });

  it('returns active:true with Format B state', () => {
    writePlanningFiles(tmpDir, {
      'STATE.md': STATE_MD_FORMAT_B,
      'ROADMAP.md': ROADMAP_MD,
    });

    const state = readGsdState(tmpDir);
    expect(state.active).toBe(true);
    expect(state.position!.phase).toBe(3);
    expect(state.position!.status).toBe('Executing plan');
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe('edge cases', () => {
  it('EMPTY_GSD_STATE is frozen', () => {
    expect(Object.isFrozen(EMPTY_GSD_STATE)).toBe(true);
  });

  it('EMPTY_GSD_STATE has correct shape', () => {
    expect(EMPTY_GSD_STATE.active).toBe(false);
    expect(EMPTY_GSD_STATE.position).toBeNull();
    expect(EMPTY_GSD_STATE.phases).toEqual([]);
    expect(EMPTY_GSD_STATE.warnings).toEqual([]);
  });

  it('requirement IDs with "None" are filtered out', () => {
    const roadmap = `### Phase 1: Test\n**Goal**: Testing\n**Requirements**: None`;
    const phases = parseRoadmapMd(roadmap);
    expect(phases[0]!.requirements).toEqual([]);
  });

  it('requirement IDs with "TBD" are filtered out', () => {
    const roadmap = `### Phase 1: Test\n**Goal**: Testing\n**Requirements**: TBD`;
    const phases = parseRoadmapMd(roadmap);
    expect(phases[0]!.requirements).toEqual([]);
  });

  it('requirement IDs with "N/A" are filtered out', () => {
    const roadmap = `### Phase 1: Test\n**Goal**: Testing\n**Requirements**: N/A`;
    const phases = parseRoadmapMd(roadmap);
    expect(phases[0]!.requirements).toEqual([]);
  });

  it('phase number sorting handles 1, 2, 2.1, 3, 10 correctly', () => {
    const phases = parseRoadmapMd(ROADMAP_MD_DECIMAL);
    const numbers = phases.map(p => p.number);
    expect(numbers).toEqual([1, 2, 2.1, 3, 10]);
  });

  it('Windows CRLF in all files does not break parsing', () => {
    const stateCrlf = STATE_MD_FORMAT_A.replace(/\n/g, '\r\n');
    const roadmapCrlf = ROADMAP_MD.replace(/\n/g, '\r\n');

    const position = parseStateMd(stateCrlf);
    expect(position).not.toBeNull();
    expect(position!.phase).toBe(3);

    const phases = parseRoadmapMd(roadmapCrlf);
    expect(phases).toHaveLength(3);
  });
});

// =============================================================================
// findActivePlanFile
// =============================================================================

describe('findActivePlanFile', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('returns correct path when plan file exists in matching phase directory', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '02-some-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan');

    const result = findActivePlanFile(phasesDir, 2, 1);
    expect(result).not.toBeNull();
    expect(result).toBe(path.join(phaseDir, '02-01-PLAN.md'));
  });

  it('returns null when planNumber is 0', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    const result = findActivePlanFile(phasesDir, 2, 0);
    expect(result).toBeNull();
  });

  it('returns null when planNumber is negative', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });

    const result = findActivePlanFile(phasesDir, 2, -1);
    expect(result).toBeNull();
  });

  it('returns null when the phase directory does not exist', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    // No phase-02 directory created

    const result = findActivePlanFile(phasesDir, 2, 1);
    expect(result).toBeNull();
  });

  it('returns null when plan file does not exist in directory', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '02-some-phase');
    fs.mkdirSync(phaseDir, { recursive: true });
    // Directory exists but no plan file for plan 3
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan');

    const result = findActivePlanFile(phasesDir, 2, 3);
    expect(result).toBeNull();
  });

  it('handles decimal phase numbers (e.g., phase 2.1)', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '02.1-inserted-fix');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02.1-01-PLAN.md'), '# Plan');

    const result = findActivePlanFile(phasesDir, 2.1, 1);
    expect(result).not.toBeNull();
    expect(result!.endsWith('02.1-01-PLAN.md')).toBe(true);
  });

  it('returns null gracefully when phasesDir does not exist', () => {
    const result = findActivePlanFile(path.join(tmpDir, 'nonexistent'), 1, 1);
    expect(result).toBeNull();
  });
});

// =============================================================================
// extractPlanMustHaves
// =============================================================================

describe('extractPlanMustHaves', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('extracts truths array from YAML frontmatter', () => {
    const planContent = `---
phase: 01-test
plan: 01
must_haves:
  truths:
    - "truth one"
    - "truth two"
---

# Plan content
`;
    const planPath = path.join(tmpDir, 'test-PLAN.md');
    fs.writeFileSync(planPath, planContent);

    const result = extractPlanMustHaves(planPath);
    expect(result).toEqual(['truth one', 'truth two']);
  });

  it('returns empty array when file does not exist', () => {
    const result = extractPlanMustHaves(path.join(tmpDir, 'nonexistent.md'));
    expect(result).toEqual([]);
  });

  it('returns empty array when file has no frontmatter', () => {
    const planPath = path.join(tmpDir, 'no-frontmatter.md');
    fs.writeFileSync(planPath, '# Just a heading\n\nSome content.');

    const result = extractPlanMustHaves(planPath);
    expect(result).toEqual([]);
  });

  it('returns empty array when frontmatter has no must_haves section', () => {
    const planContent = `---
phase: 01-test
plan: 01
---

# Plan content
`;
    const planPath = path.join(tmpDir, 'no-musthaves.md');
    fs.writeFileSync(planPath, planContent);

    const result = extractPlanMustHaves(planPath);
    expect(result).toEqual([]);
  });

  it('handles CRLF line endings correctly', () => {
    const planContent = `---\r\nphase: 01-test\r\nplan: 01\r\nmust_haves:\r\n  truths:\r\n    - "crlf truth one"\r\n    - "crlf truth two"\r\n---\r\n\r\n# Content\r\n`;
    const planPath = path.join(tmpDir, 'crlf-plan.md');
    fs.writeFileSync(planPath, planContent);

    const result = extractPlanMustHaves(planPath);
    expect(result).toEqual(['crlf truth one', 'crlf truth two']);
  });

  it('limits output to first 4 truths', () => {
    const planContent = `---
phase: 01-test
plan: 01
must_haves:
  truths:
    - "truth one"
    - "truth two"
    - "truth three"
    - "truth four"
    - "truth five"
    - "truth six"
---

# Plan
`;
    const planPath = path.join(tmpDir, 'many-truths.md');
    fs.writeFileSync(planPath, planContent);

    const result = extractPlanMustHaves(planPath);
    expect(result).toHaveLength(4);
    expect(result).toEqual(['truth one', 'truth two', 'truth three', 'truth four']);
  });

  it('handles truths with both double-quoted and unquoted values', () => {
    const planContent = `---
phase: 01-test
plan: 01
must_haves:
  truths:
    - "quoted truth"
    - unquoted truth value
---

# Plan
`;
    const planPath = path.join(tmpDir, 'mixed-quotes.md');
    fs.writeFileSync(planPath, planContent);

    const result = extractPlanMustHaves(planPath);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('quoted truth');
    expect(result[1]).toBe('unquoted truth value');
  });
});

// =============================================================================
// countCompletedRequirements
// =============================================================================

describe('countCompletedRequirements', () => {
  beforeEach(() => {
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('returns correct counts for mixed checked/unchecked requirements', () => {
    const reqContent = `# Requirements

- [x] **REQ-01**: First requirement - done
- [ ] **REQ-02**: Second requirement - pending
- [x] **REQ-03**: Third requirement - also done
`;
    const reqPath = path.join(tmpDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, reqContent);

    const result = countCompletedRequirements(['REQ-01', 'REQ-02'], reqPath);
    expect(result).toEqual({ complete: 1, total: 2 });
  });

  it('returns all zeros when all checkboxes are unchecked', () => {
    const reqContent = `# Requirements

- [ ] **REQ-01**: First requirement
- [ ] **REQ-02**: Second requirement
- [ ] **REQ-03**: Third requirement
`;
    const reqPath = path.join(tmpDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, reqContent);

    const result = countCompletedRequirements(['REQ-01', 'REQ-02', 'REQ-03'], reqPath);
    expect(result).toEqual({ complete: 0, total: 3 });
  });

  it('returns complete 0 with total from input when file does not exist', () => {
    const result = countCompletedRequirements(
      ['REQ-01', 'REQ-02'],
      path.join(tmpDir, 'nonexistent.md'),
    );
    expect(result).toEqual({ complete: 0, total: 2 });
  });

  it('returns complete 0 with total N when file is empty', () => {
    const reqPath = path.join(tmpDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '');

    const result = countCompletedRequirements(['REQ-01', 'REQ-02'], reqPath);
    expect(result).toEqual({ complete: 0, total: 2 });
  });

  it('only counts IDs from the provided requirementIds array', () => {
    const reqContent = `# Requirements

- [x] **REQ-01**: First requirement - done
- [x] **REQ-02**: Second requirement - done
- [x] **REQ-03**: Third requirement - done
`;
    const reqPath = path.join(tmpDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, reqContent);

    // Only ask about REQ-01 and REQ-03 (skip REQ-02)
    const result = countCompletedRequirements(['REQ-01', 'REQ-03'], reqPath);
    expect(result).toEqual({ complete: 2, total: 2 });
  });

  it('returns {complete:0, total:0} for empty requirementIds array', () => {
    const reqPath = path.join(tmpDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, '# Requirements\n- [x] **REQ-01**: Done');

    const result = countCompletedRequirements([], reqPath);
    expect(result).toEqual({ complete: 0, total: 0 });
  });
});

// =============================================================================
// Integration with real project data
// =============================================================================

const REAL_PLANNING_DIR = path.resolve(__dirname, '../../..', '.planning');

describe.skipIf(!fs.existsSync(REAL_PLANNING_DIR))('real project integration', () => {
  it('parses the actual .planning/ directory of this project', () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const state = readGsdState(projectRoot);

    expect(state.active).toBe(true);
    expect(state.phases.length).toBe(8);
    expect(state.position).not.toBeNull();
    expect(state.position!.phase).toBeGreaterThanOrEqual(1);

    // Phase 1 should have PCTX-01 requirement
    const phase1 = state.phases.find(p => p.number === 1);
    expect(phase1).toBeDefined();
    expect(phase1!.requirements).toContain('PCTX-01');
  });
});
