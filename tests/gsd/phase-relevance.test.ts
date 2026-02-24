/**
 * Claudex v2 -- Phase Relevance Engine Tests
 *
 * TDD tests for src/gsd/phase-relevance.ts.
 * Covers extractPlanFilesModified, getPhaseRelevanceSet, applyPhaseBoost,
 * and edge cases (CRLF, completed plans, empty relevance, plan 0).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ScoredFile } from '../../src/shared/types.js';
import type { PhaseRelevanceSet } from '../../src/gsd/types.js';

import {
  extractPlanFilesModified,
  getPhaseRelevanceSet,
  applyPhaseBoost,
  ACTIVE_PLAN_BOOST,
  OTHER_PLAN_BOOST,
} from '../../src/gsd/phase-relevance.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function makeScoredFile(
  filePath: string,
  rawPressure: number,
  temperature: 'HOT' | 'WARM' | 'COLD' = 'WARM',
): ScoredFile {
  return {
    path: filePath,
    raw_pressure: rawPressure,
    temperature,
    system_bucket: 0,
    pressure_bucket: 0,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-phase-relevance-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// extractPlanFilesModified
// =============================================================================

describe('extractPlanFilesModified', () => {
  it('extracts files from valid YAML frontmatter', () => {
    const planPath = path.join(tmpDir, '03-01-PLAN.md');
    fs.writeFileSync(planPath, `---
phase: 03-test
plan: 01
files_modified:
  - Claudex/src/gsd/types.ts
  - Claudex/src/gsd/state-reader.ts
  - Claudex/src/gsd/phase-relevance.ts
---

# Plan content
`);

    const files = extractPlanFilesModified(planPath);
    expect(files).toEqual([
      'Claudex/src/gsd/types.ts',
      'Claudex/src/gsd/state-reader.ts',
      'Claudex/src/gsd/phase-relevance.ts',
    ]);
  });

  it('returns empty for plan with no frontmatter', () => {
    const planPath = path.join(tmpDir, 'no-fm.md');
    fs.writeFileSync(planPath, '# Just a plan\n\nNo frontmatter here.\n');

    const files = extractPlanFilesModified(planPath);
    expect(files).toEqual([]);
  });

  it('returns empty for plan with no files_modified field', () => {
    const planPath = path.join(tmpDir, 'no-files.md');
    fs.writeFileSync(planPath, `---
phase: 03-test
plan: 01
---

# Plan content
`);

    const files = extractPlanFilesModified(planPath);
    expect(files).toEqual([]);
  });

  it('handles quoted and unquoted paths', () => {
    const planPath = path.join(tmpDir, 'quoted.md');
    fs.writeFileSync(planPath, `---
files_modified:
  - "Claudex/src/shared/types.ts"
  - 'Claudex/src/gsd/types.ts'
  - Claudex/src/gsd/state-reader.ts
---
`);

    const files = extractPlanFilesModified(planPath);
    expect(files).toEqual([
      'Claudex/src/shared/types.ts',
      'Claudex/src/gsd/types.ts',
      'Claudex/src/gsd/state-reader.ts',
    ]);
  });

  it('handles CRLF line endings', () => {
    const planPath = path.join(tmpDir, 'crlf.md');
    fs.writeFileSync(planPath,
      '---\r\nfiles_modified:\r\n  - Claudex/src/foo.ts\r\n  - Claudex/src/bar.ts\r\n---\r\n');

    const files = extractPlanFilesModified(planPath);
    expect(files).toEqual([
      'Claudex/src/foo.ts',
      'Claudex/src/bar.ts',
    ]);
  });

  it('returns empty for non-existent file', () => {
    const files = extractPlanFilesModified(path.join(tmpDir, 'nope.md'));
    expect(files).toEqual([]);
  });
});

// =============================================================================
// getPhaseRelevanceSet
// =============================================================================

describe('getPhaseRelevanceSet', () => {
  it('puts active plan files into activePlanFiles, other plans into otherPlanFiles', () => {
    // Create phase directory: 03-test-phase/
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '03-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan 01 (active): files A, B
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---
files_modified:
  - src/fileA.ts
  - src/fileB.ts
---
`);

    // Plan 02 (other): files C, D
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---
files_modified:
  - src/fileC.ts
  - src/fileD.ts
---
`);

    const result = getPhaseRelevanceSet(phasesDir, 3, 1);
    expect(result.activePlanFiles).toEqual(new Set(['src/fileA.ts', 'src/fileB.ts']));
    expect(result.otherPlanFiles).toEqual(new Set(['src/fileC.ts', 'src/fileD.ts']));
  });

  it('when activePlanNumber=0, all files go into otherPlanFiles', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '03-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---
files_modified:
  - src/fileA.ts
---
`);
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---
files_modified:
  - src/fileB.ts
---
`);

    const result = getPhaseRelevanceSet(phasesDir, 3, 0);
    expect(result.activePlanFiles.size).toBe(0);
    expect(result.otherPlanFiles).toEqual(new Set(['src/fileA.ts', 'src/fileB.ts']));
  });

  it('excludes completed plans (with matching SUMMARY.md)', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '03-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan 01: completed (has SUMMARY)
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---
files_modified:
  - src/completed.ts
---
`);
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), '# Summary\nDone.');

    // Plan 02: active, not completed
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---
files_modified:
  - src/active.ts
---
`);

    const result = getPhaseRelevanceSet(phasesDir, 3, 2);
    expect(result.activePlanFiles).toEqual(new Set(['src/active.ts']));
    expect(result.otherPlanFiles.size).toBe(0);
    // completed.ts should not appear in either set
    expect(result.activePlanFiles.has('src/completed.ts')).toBe(false);
    expect(result.otherPlanFiles.has('src/completed.ts')).toBe(false);
  });

  it('returns empty sets when phase directory does not exist', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    fs.mkdirSync(phasesDir, { recursive: true });
    // No phase 99 directory

    const result = getPhaseRelevanceSet(phasesDir, 99, 1);
    expect(result.activePlanFiles.size).toBe(0);
    expect(result.otherPlanFiles.size).toBe(0);
  });

  it('file appearing in both active and other plan goes to activePlanFiles (dedup)', () => {
    const phasesDir = path.join(tmpDir, 'phases');
    const phaseDir = path.join(phasesDir, '03-test-phase');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Both plans modify the same file
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---
files_modified:
  - src/shared.ts
  - src/onlyA.ts
---
`);
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---
files_modified:
  - src/shared.ts
  - src/onlyB.ts
---
`);

    const result = getPhaseRelevanceSet(phasesDir, 3, 1);
    expect(result.activePlanFiles.has('src/shared.ts')).toBe(true);
    expect(result.otherPlanFiles.has('src/shared.ts')).toBe(false);
    expect(result.otherPlanFiles.has('src/onlyB.ts')).toBe(true);
  });
});

// =============================================================================
// applyPhaseBoost
// =============================================================================

describe('applyPhaseBoost', () => {
  it('active plan file gets 1.4x multiplier and phase_boosted: true', () => {
    const scores: ScoredFile[] = [makeScoredFile('src/fileA.ts', 0.5)];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(['src/fileA.ts']),
      otherPlanFiles: new Set(),
    };

    const result = applyPhaseBoost(scores, relevance);
    expect(result[0]!.raw_pressure).toBeCloseTo(0.5 * ACTIVE_PLAN_BOOST, 5);
    expect(result[0]!.phase_boosted).toBe(true);
  });

  it('other plan file gets 1.2x multiplier and phase_boosted: true', () => {
    const scores: ScoredFile[] = [makeScoredFile('src/fileC.ts', 0.5)];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(),
      otherPlanFiles: new Set(['src/fileC.ts']),
    };

    const result = applyPhaseBoost(scores, relevance);
    expect(result[0]!.raw_pressure).toBeCloseTo(0.5 * OTHER_PLAN_BOOST, 5);
    expect(result[0]!.phase_boosted).toBe(true);
  });

  it('non-phase file gets no boost and no phase_boosted field', () => {
    const scores: ScoredFile[] = [makeScoredFile('src/unrelated.ts', 0.5)];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(['src/other.ts']),
      otherPlanFiles: new Set(),
    };

    const result = applyPhaseBoost(scores, relevance);
    expect(result[0]!.raw_pressure).toBe(0.5);
    expect(result[0]!.phase_boosted).toBeUndefined();
  });

  it('boosted raw_pressure is capped at 1.0', () => {
    const scores: ScoredFile[] = [makeScoredFile('src/hot.ts', 0.8)];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(['src/hot.ts']),
      otherPlanFiles: new Set(),
    };

    // 0.8 * 1.4 = 1.12 -> capped at 1.0
    const result = applyPhaseBoost(scores, relevance);
    expect(result[0]!.raw_pressure).toBe(1.0);
    expect(result[0]!.phase_boosted).toBe(true);
  });

  it('output is sorted by raw_pressure descending (boost can change ranking)', () => {
    const scores: ScoredFile[] = [
      makeScoredFile('src/low-phase.ts', 0.3),     // will be boosted: 0.3 * 1.4 = 0.42
      makeScoredFile('src/high-normal.ts', 0.4),    // no boost: stays 0.4
    ];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(['src/low-phase.ts']),
      otherPlanFiles: new Set(),
    };

    const result = applyPhaseBoost(scores, relevance);
    expect(result[0]!.path).toBe('src/low-phase.ts');
    expect(result[1]!.path).toBe('src/high-normal.ts');
  });

  it('empty relevance set returns output identical to input (no regression)', () => {
    const scores: ScoredFile[] = [
      makeScoredFile('src/a.ts', 0.8, 'HOT'),
      makeScoredFile('src/b.ts', 0.4, 'WARM'),
    ];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(),
      otherPlanFiles: new Set(),
    };

    const result = applyPhaseBoost(scores, relevance);
    expect(result).toEqual(scores);
  });

  it('temperature is reclassified after boost using 0.7/0.3 thresholds', () => {
    const scores: ScoredFile[] = [
      // 0.55 * 1.4 = 0.77 -> HOT (>= 0.7)
      makeScoredFile('src/warm-to-hot.ts', 0.55, 'WARM'),
      // 0.2 * 1.4 = 0.28 -> COLD (< 0.3)
      makeScoredFile('src/cold-stays-cold.ts', 0.2, 'COLD'),
      // 0.25 * 1.2 = 0.30 -> WARM (>= 0.3)
      makeScoredFile('src/cold-to-warm.ts', 0.25, 'COLD'),
    ];
    const relevance: PhaseRelevanceSet = {
      activePlanFiles: new Set(['src/warm-to-hot.ts', 'src/cold-stays-cold.ts']),
      otherPlanFiles: new Set(['src/cold-to-warm.ts']),
    };

    const result = applyPhaseBoost(scores, relevance);

    const hotFile = result.find(f => f.path === 'src/warm-to-hot.ts')!;
    expect(hotFile.temperature).toBe('HOT');

    const coldFile = result.find(f => f.path === 'src/cold-stays-cold.ts')!;
    expect(coldFile.temperature).toBe('COLD');

    const warmFile = result.find(f => f.path === 'src/cold-to-warm.ts')!;
    expect(warmFile.temperature).toBe('WARM');
  });
});

// =============================================================================
// Integration: real .planning/ data
// =============================================================================

describe('integration: real .planning/ data', () => {
  // Use this project's actual .planning/phases/ directory
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  const phasesDir = path.join(projectRoot, '.planning', 'phases');

  it('phase 1 plans are all completed (summaries exist) so relevance set is empty', () => {
    const result = getPhaseRelevanceSet(phasesDir, 1, 1);
    // Phase 1 has 01-01-PLAN.md + 01-01-SUMMARY.md -> completed -> excluded
    expect(result.activePlanFiles.size).toBe(0);
    expect(result.otherPlanFiles.size).toBe(0);
  });

  it('phase 3 plans are all completed (summaries exist) so relevance set is empty', () => {
    // Both 03-01 and 03-02 have SUMMARY.md files -> completed -> excluded
    const result = getPhaseRelevanceSet(phasesDir, 3, 2);
    expect(result.activePlanFiles.size).toBe(0);
    expect(result.otherPlanFiles.size).toBe(0);
  });

  it('extractPlanFilesModified works on real 02-01-PLAN.md', () => {
    const planPath = path.join(phasesDir, '02-phase-aware-context-injection', '02-01-PLAN.md');
    const files = extractPlanFilesModified(planPath);
    expect(files).toContain('Claudex/src/gsd/state-reader.ts');
    expect(files).toContain('Claudex/tests/gsd/state-reader.test.ts');
    expect(files.length).toBe(2);
  });
});
