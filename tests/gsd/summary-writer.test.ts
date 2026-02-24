/**
 * Claudex v2 -- Summary Writer Tests
 *
 * TDD tests for src/gsd/summary-writer.ts.
 * Covers writePhaseSummary (debounce, generation, format, error handling)
 * and archivePhaseSummary (copy, delete, edge cases).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ScoredFile } from '../../src/shared/types.js';
import type { GsdState, GsdCurrentPosition, PhaseRelevanceSet } from '../../src/gsd/types.js';

// =============================================================================
// Mocks
// =============================================================================

// Mock getPressureScores from pressure.ts
vi.mock('../../src/db/pressure.js', () => ({
  getPressureScores: vi.fn(() => []),
}));

// Mock phase-relevance.ts
vi.mock('../../src/gsd/phase-relevance.js', () => ({
  getPhaseRelevanceSet: vi.fn(() => ({
    activePlanFiles: new Set<string>(),
    otherPlanFiles: new Set<string>(),
  })),
  applyPhaseBoost: vi.fn((scores: ScoredFile[]) => scores),
}));

import { writePhaseSummary, archivePhaseSummary } from '../../src/gsd/summary-writer.js';
import { getPressureScores } from '../../src/db/pressure.js';
import { getPhaseRelevanceSet, applyPhaseBoost } from '../../src/gsd/phase-relevance.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;

function makeGsdState(overrides: Partial<GsdState> = {}): GsdState {
  return {
    active: true,
    position: {
      phase: 4,
      totalPhases: 8,
      phaseName: 'Summary Generation',
      plan: 1,
      totalPlans: 2,
      status: 'Executing',
    },
    phases: [],
    warnings: [],
    ...overrides,
  };
}

/** Create .planning/context/SUMMARY.md with given content and optional mtime backdate */
function createSummaryFile(content: string, backdateMinutes?: number): string {
  const contextDir = path.join(tmpDir, '.planning', 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  const summaryPath = path.join(contextDir, 'SUMMARY.md');
  fs.writeFileSync(summaryPath, content, 'utf-8');

  if (backdateMinutes !== undefined) {
    const now = Date.now();
    const past = now - backdateMinutes * 60 * 1000;
    fs.utimesSync(summaryPath, new Date(past), new Date(past));
  }

  return summaryPath;
}

// Stub db object (just needs to be passed through)
const fakeDb = {} as any;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-summary-writer-'));
  // Reset all mocks
  vi.mocked(getPressureScores).mockReset().mockReturnValue([]);
  vi.mocked(getPhaseRelevanceSet).mockReset().mockReturnValue({
    activePlanFiles: new Set<string>(),
    otherPlanFiles: new Set<string>(),
  });
  vi.mocked(applyPhaseBoost).mockReset().mockImplementation((scores) => scores);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// =============================================================================
// writePhaseSummary
// =============================================================================

describe('writePhaseSummary', () => {
  it('1. skips write when SUMMARY.md is less than 5 minutes old (debounce)', () => {
    const content = '# Old summary\n';
    createSummaryFile(content); // mtime = now (fresh)

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(false);

    // File unchanged
    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe(content);
  });

  it('2. writes when SUMMARY.md is missing', () => {
    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    expect(fs.existsSync(summaryPath)).toBe(true);
  });

  it('3. writes when SUMMARY.md is stale (> 5 min old)', () => {
    createSummaryFile('# Stale summary\n', 6); // 6 minutes ago

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    const content = fs.readFileSync(summaryPath, 'utf-8');
    expect(content).not.toBe('# Stale summary\n');
    expect(content).toContain('# Phase Summary');
  });

  it('4. output contains Phase-Relevant Files section with correct format', () => {
    // Mock pressure scores
    vi.mocked(getPressureScores).mockReturnValue([
      { file_path: 'src/auth.ts', raw_pressure: 0.85, temperature: 'HOT', decay_rate: 0.05 },
      { file_path: 'src/db.ts', raw_pressure: 0.55, temperature: 'WARM', decay_rate: 0.05 },
      { file_path: 'src/utils.ts', raw_pressure: 0.15, temperature: 'COLD', decay_rate: 0.05 },
    ] as any);

    // Mock relevance set
    vi.mocked(getPhaseRelevanceSet).mockReturnValue({
      activePlanFiles: new Set(['src/auth.ts']),
      otherPlanFiles: new Set(),
    });

    // Mock applyPhaseBoost to mark phase-boosted files
    vi.mocked(applyPhaseBoost).mockImplementation((scores) => {
      return scores.map(s => ({
        ...s,
        phase_boosted: s.path === 'src/auth.ts' ? true : undefined,
      })) as ScoredFile[];
    });

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    const content = fs.readFileSync(summaryPath, 'utf-8');

    expect(content).toContain('## Phase-Relevant Files');
    expect(content).toContain('src/auth.ts');
    expect(content).toContain('0.85');
    expect(content).toContain('HOT');

    // Verify getPressureScores was called with projectName, not projectDir
    expect(getPressureScores).toHaveBeenCalledWith(fakeDb, 'test-project');
  });

  it('5. output contains Other Notable Files (WARM+ non-boosted, excludes COLD)', () => {
    vi.mocked(getPressureScores).mockReturnValue([
      { file_path: 'src/auth.ts', raw_pressure: 0.85, temperature: 'HOT', decay_rate: 0.05 },
      { file_path: 'src/db.ts', raw_pressure: 0.55, temperature: 'WARM', decay_rate: 0.05 },
      { file_path: 'src/cold.ts', raw_pressure: 0.15, temperature: 'COLD', decay_rate: 0.05 },
    ] as any);

    vi.mocked(getPhaseRelevanceSet).mockReturnValue({
      activePlanFiles: new Set(['src/auth.ts']),
      otherPlanFiles: new Set(),
    });

    vi.mocked(applyPhaseBoost).mockImplementation((scores) => {
      return scores.map(s => ({
        ...s,
        phase_boosted: s.path === 'src/auth.ts' ? true : undefined,
      })) as ScoredFile[];
    });

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(true);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    const content = fs.readFileSync(summaryPath, 'utf-8');

    expect(content).toContain('## Other Notable Files');
    expect(content).toContain('src/db.ts');
    // COLD files should NOT appear in Other Notable Files
    expect(content).not.toContain('src/cold.ts');
  });

  it('6. creates .planning/context/ directory if it does not exist', () => {
    // tmpDir has no .planning/context/ yet
    const contextDir = path.join(tmpDir, '.planning', 'context');
    expect(fs.existsSync(contextDir)).toBe(false);

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, makeGsdState());
    expect(result).toBe(true);
    expect(fs.existsSync(contextDir)).toBe(true);

    const summaryPath = path.join(contextDir, 'SUMMARY.md');
    expect(fs.existsSync(summaryPath)).toBe(true);
  });

  it('7. returns false when gsdState.active is false', () => {
    const state = makeGsdState({ active: false });

    const result = writePhaseSummary(tmpDir, 'test-project', fakeDb, state);
    expect(result).toBe(false);

    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it('8. never throws on error (e.g., invalid projectDir)', () => {
    // Pass a non-writable / nonsense directory
    const bogusDir = path.join(tmpDir, 'nonexistent', 'deep', 'path', '\0invalid');

    let result: boolean | undefined;
    expect(() => {
      result = writePhaseSummary(bogusDir, 'test-project', fakeDb, makeGsdState());
    }).not.toThrow();
    expect(result).toBe(false);
  });
});

// =============================================================================
// archivePhaseSummary
// =============================================================================

describe('archivePhaseSummary', () => {
  it('9. archives and clears SUMMARY.md', () => {
    const originalContent = '# Phase Summary\nSome content here.\n';
    createSummaryFile(originalContent);

    const result = archivePhaseSummary(tmpDir, 4, 'summary-generation');
    expect(result).toBe(true);

    // Archive exists with same content
    const archivePath = path.join(
      tmpDir, '.planning', 'context', 'archive', '04-summary-generation.md',
    );
    expect(fs.existsSync(archivePath)).toBe(true);
    expect(fs.readFileSync(archivePath, 'utf-8')).toBe(originalContent);

    // Original deleted
    const summaryPath = path.join(tmpDir, '.planning', 'context', 'SUMMARY.md');
    expect(fs.existsSync(summaryPath)).toBe(false);
  });

  it('10. returns false when no SUMMARY.md exists', () => {
    const result = archivePhaseSummary(tmpDir, 4, 'summary-generation');
    expect(result).toBe(false);
  });

  it('11. creates archive directory if it does not exist', () => {
    createSummaryFile('# Summary\n');

    const archiveDir = path.join(tmpDir, '.planning', 'context', 'archive');
    expect(fs.existsSync(archiveDir)).toBe(false);

    const result = archivePhaseSummary(tmpDir, 4, 'summary-generation');
    expect(result).toBe(true);
    expect(fs.existsSync(archiveDir)).toBe(true);
  });
});
