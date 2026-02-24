/**
 * Claudex v2 -- Cross-Phase Writer Tests
 *
 * TDD tests for src/gsd/cross-phase-writer.ts.
 * Covers detectRecurringPatterns (key-files extraction, threshold, sorting),
 * extractDecisionHistory (session logs, handoffs, phase attribution),
 * and writeCrossPhaseSummary (debounce, output format, directory creation).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectRecurringPatterns,
  extractDecisionHistory,
  writeCrossPhaseSummary,
} from '../../src/gsd/cross-phase-writer.js';

// =============================================================================
// Helpers
// =============================================================================

let tmpDir: string;
let projectDir: string;
let claudexDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-cross-phase-'));
  projectDir = tmpDir;
  claudexDir = path.join(tmpDir, 'Claudex');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a plan SUMMARY.md file in the temp project structure */
function createSummary(
  phaseSlug: string,
  planNumber: string,
  opts: {
    phase?: string;
    created?: string[];
    modified?: string[];
    title?: string;
  } = {},
): void {
  const phaseDir = path.join(projectDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });

  const phase = opts.phase ?? phaseSlug;
  const created = opts.created ?? [];
  const modified = opts.modified ?? [];
  const title = opts.title ?? `Plan ${planNumber} Summary`;

  let content = '---\n';
  content += `phase: ${phase}\n`;
  content += `plan: ${planNumber}\n`;
  content += 'key-files:\n';
  if (created.length > 0) {
    content += '  created:\n';
    for (const f of created) content += `    - ${f}\n`;
  }
  if (modified.length > 0) {
    content += '  modified:\n';
    for (const f of modified) content += `    - ${f}\n`;
  }
  content += '---\n\n';
  content += `# ${title}\n`;

  const prefix = phaseSlug.match(/^(\d+)/)?.[1] ?? '00';
  const fileName = `${prefix}-${planNumber}-SUMMARY.md`;
  fs.writeFileSync(path.join(phaseDir, fileName), content, 'utf-8');
}

/** Create a session log file in the temp Claudex structure */
function createSessionLog(
  filename: string,
  opts: {
    handoffId?: string | null;
    decisions?: string[];
  } = {},
): void {
  const sessionsDir = path.join(claudexDir, 'context', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const handoffId = opts.handoffId === undefined ? null : opts.handoffId;
  const decisions = opts.decisions ?? [];

  let content = '---\n';
  content += 'schema: claudex/session-log\n';
  content += 'version: 1\n';
  content += `handoff_id: ${handoffId ?? 'null'}\n`;
  content += '---\n\n';
  content += '# Session\n\n';

  if (decisions.length > 0) {
    content += '## Decisions Made\n';
    for (const d of decisions) content += `- ${d}\n`;
    content += '\n';
  }

  content += '## Learnings\n';
  content += '- Some learning\n';

  fs.writeFileSync(path.join(sessionsDir, filename), content, 'utf-8');
}

/** Create a handoff file in the temp Claudex structure */
function createHandoff(
  filePath: string,
  opts: {
    handoffId?: string | null;
    decisions?: string[];
    headingFormat?: string;
  } = {},
): void {
  const fullPath = path.join(claudexDir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });

  const handoffId = opts.handoffId === undefined ? null : opts.handoffId;
  const decisions = opts.decisions ?? [];
  const heading = opts.headingFormat ?? '## Decisions Made';

  let content = '---\n';
  content += `handoff_id: ${handoffId ?? 'null'}\n`;
  content += 'created_at: 2026-02-20T10:00:00Z\n';
  content += '---\n\n';
  content += '# Handoff\n\n';

  if (decisions.length > 0) {
    content += `${heading}\n`;
    for (const d of decisions) content += `- ${d}\n`;
    content += '\n';
  }

  content += '## Next Steps\n';
  content += '- Do something\n';

  fs.writeFileSync(fullPath, content, 'utf-8');
}

/** Create CROSS-PHASE.md with optional mtime backdate */
function createCrossPhaseFile(backdateMinutes?: number): string {
  const contextDir = path.join(projectDir, '.planning', 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  const filePath = path.join(contextDir, 'CROSS-PHASE.md');
  fs.writeFileSync(filePath, '# Cross-Phase Intelligence\n', 'utf-8');

  if (backdateMinutes !== undefined) {
    const past = Date.now() - backdateMinutes * 60 * 1000;
    fs.utimesSync(filePath, new Date(past), new Date(past));
  }

  return filePath;
}

// =============================================================================
// detectRecurringPatterns
// =============================================================================

describe('detectRecurringPatterns', () => {
  it('1. returns empty array when no phase directories exist', () => {
    const result = detectRecurringPatterns(projectDir);
    expect(result).toEqual([]);
  });

  it('2. returns empty array when files appear in only 1 phase', () => {
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/state-reader.ts'],
    });
    createSummary('02-context-injection', '01', {
      created: ['src/gsd/context-injector.ts'],
    });

    const result = detectRecurringPatterns(projectDir);
    expect(result).toEqual([]);
  });

  it('3. returns patterns when same file appears in 2+ phase SUMMARY.md key-files', () => {
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts', 'src/gsd/state-reader.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    const result = detectRecurringPatterns(projectDir);
    expect(result.length).toBe(1);
    expect(result[0]!.filePath).toBe('src/gsd/types.ts');
    expect(result[0]!.appearances.length).toBe(2);
  });

  it('4. reason includes created vs modified distinction and plan description', () => {
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    const result = detectRecurringPatterns(projectDir);
    expect(result.length).toBe(1);

    const appearances = result[0]!.appearances;
    expect(appearances[0]!.reason).toContain('created');
    expect(appearances[0]!.reason).toContain('State Reader');
    expect(appearances[1]!.reason).toContain('modified');
    expect(appearances[1]!.reason).toContain('Scoring Engine');
  });

  it('5. sorts patterns by number of appearances (most recurring first)', () => {
    // types.ts appears in 3 phases, state-reader.ts in 2
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts', 'src/gsd/state-reader.ts'],
      title: 'State Reader',
    });
    createSummary('02-injection', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Context Injection',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts', 'src/gsd/state-reader.ts'],
      title: 'Scoring Engine',
    });

    const result = detectRecurringPatterns(projectDir);
    expect(result.length).toBe(2);
    // types.ts (3 appearances) should come before state-reader.ts (2 appearances)
    expect(result[0]!.filePath).toBe('src/gsd/types.ts');
    expect(result[0]!.appearances.length).toBe(3);
    expect(result[1]!.filePath).toBe('src/gsd/state-reader.ts');
    expect(result[1]!.appearances.length).toBe(2);
  });
});

// =============================================================================
// extractDecisionHistory
// =============================================================================

describe('extractDecisionHistory', () => {
  it('1. returns empty map when no session logs exist', () => {
    const result = extractDecisionHistory(claudexDir);
    expect(result.size).toBe(0);
  });

  it('2. extracts decisions from session logs with Decisions Made section', () => {
    createSessionLog('2026-02-21_session-1.md', {
      handoffId: 'claudex-v2-gsd-phase2',
      decisions: ['Decision A', 'Decision B'],
    });

    const result = extractDecisionHistory(claudexDir);
    expect(result.size).toBeGreaterThan(0);

    // Find the phase entry that contains these decisions
    let found = false;
    for (const [, decisions] of result) {
      const texts = decisions.map(d => d.decision);
      if (texts.includes('Decision A') && texts.includes('Decision B')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('3. attributes decisions to correct phase via handoff_id', () => {
    createSessionLog('2026-02-21_session-1.md', {
      handoffId: 'claudex-v2-gsd-phase3',
      decisions: ['Phase 3 decision'],
    });

    const result = extractDecisionHistory(claudexDir);
    // Should have a "Phase 3" key (or similar)
    const keys = Array.from(result.keys());
    const phase3Key = keys.find(k => k.includes('3'));
    expect(phase3Key).toBeDefined();

    const decisions = result.get(phase3Key!)!;
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.decision).toBe('Phase 3 decision');
    expect(decisions[0]!.source).toBe('session');
  });

  it('4. groups sessions with null/active handoff_id under General', () => {
    createSessionLog('2026-02-15_session-1.md', {
      handoffId: null,
      decisions: ['General decision'],
    });
    createSessionLog('2026-02-15_session-2.md', {
      handoffId: 'active',
      decisions: ['Active decision'],
    });

    const result = extractDecisionHistory(claudexDir);
    // Both should be grouped under some non-phase label
    let generalDecisions: string[] = [];
    for (const [key, decisions] of result) {
      if (!key.match(/Phase \d/)) {
        generalDecisions = generalDecisions.concat(decisions.map(d => d.decision));
      }
    }
    expect(generalDecisions).toContain('General decision');
    expect(generalDecisions).toContain('Active decision');
  });

  it('5. extracts decisions from handoff files with flexible heading matching', () => {
    createHandoff('context/handoffs/ACTIVE.md', {
      handoffId: 'claudex-v2-gsd-phase3',
      decisions: ['Handoff decision'],
      headingFormat: '## Design Decisions',
    });

    const result = extractDecisionHistory(claudexDir);
    let found = false;
    for (const [, decisions] of result) {
      if (decisions.some(d => d.decision === 'Handoff decision' && d.source === 'handoff')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('6. groups by phase chronologically', () => {
    createSessionLog('2026-02-20_session-1.md', {
      handoffId: 'claudex-v2-gsd-phase2',
      decisions: ['Earlier decision'],
    });
    createSessionLog('2026-02-22_session-1.md', {
      handoffId: 'claudex-v2-gsd-phase3',
      decisions: ['Later decision'],
    });

    const result = extractDecisionHistory(claudexDir);
    const keys = Array.from(result.keys());
    // Phase 2 key should come before Phase 3 key
    const phase2Idx = keys.findIndex(k => k.includes('2'));
    const phase3Idx = keys.findIndex(k => k.includes('3'));
    expect(phase2Idx).toBeLessThan(phase3Idx);
  });
});

// =============================================================================
// writeCrossPhaseSummary
// =============================================================================

describe('writeCrossPhaseSummary', () => {
  it('1. returns false when no data to write', () => {
    const result = writeCrossPhaseSummary(projectDir, claudexDir);
    expect(result).toBe(false);
  });

  it('2. writes CROSS-PHASE.md with both sections', () => {
    // Create pattern data: same file in 2 phases
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    // Create decision data
    createSessionLog('2026-02-21_session-1.md', {
      handoffId: 'claudex-v2-gsd-phase2',
      decisions: ['Some decision'],
    });

    const result = writeCrossPhaseSummary(projectDir, claudexDir);
    expect(result).toBe(true);

    const outputPath = path.join(projectDir, '.planning', 'context', 'CROSS-PHASE.md');
    expect(fs.existsSync(outputPath)).toBe(true);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('# Cross-Phase Intelligence');
    expect(content).toContain('## Recurring File Patterns');
    expect(content).toContain('## Decision History');
    expect(content).toContain('src/gsd/types.ts');
    expect(content).toContain('Some decision');
  });

  it('3. respects debounce (returns false if file is fresh)', () => {
    createCrossPhaseFile(); // mtime = now (fresh)

    // Create some data so there would be something to write
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    const result = writeCrossPhaseSummary(projectDir, claudexDir);
    expect(result).toBe(false);
  });

  it('4. creates .planning/context/ directory if missing', () => {
    // Create pattern data but no context dir
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    const contextDir = path.join(projectDir, '.planning', 'context');
    expect(fs.existsSync(contextDir)).toBe(false);

    const result = writeCrossPhaseSummary(projectDir, claudexDir);
    expect(result).toBe(true);
    expect(fs.existsSync(contextDir)).toBe(true);
  });

  it('5. returns true on successful write', () => {
    createSummary('01-state-reader', '01', {
      created: ['src/gsd/types.ts'],
      title: 'State Reader',
    });
    createSummary('03-scoring', '01', {
      modified: ['src/gsd/types.ts'],
      title: 'Scoring Engine',
    });

    const result = writeCrossPhaseSummary(projectDir, claudexDir);
    expect(result).toBe(true);
  });
});
