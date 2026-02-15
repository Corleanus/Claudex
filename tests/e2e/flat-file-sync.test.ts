import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  mirrorObservation,
  mirrorReasoning,
  mirrorConsensus,
  mirrorPressureScores,
  sanitizeFilename,
} from '../../src/lib/flat-file-mirror.js';
import type {
  Observation,
  ReasoningChain,
  ConsensusDecision,
  PressureScore,
  Scope,
} from '../../src/shared/types.js';

// =============================================================================
// Helpers
// =============================================================================

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'test-sess-001',
    timestamp: '2026-02-15T10:30:00.000Z',
    timestamp_epoch: 1739612600000,
    tool_name: 'Read',
    category: 'discovery',
    title: 'Found database module',
    content: 'The database uses SQLite with FTS5',
    importance: 3,
    ...overrides,
  };
}

function makeReasoning(overrides: Partial<ReasoningChain> = {}): ReasoningChain {
  return {
    session_id: 'test-sess-001',
    timestamp: '2026-02-15T10:30:00.000Z',
    timestamp_epoch: 1739612600000,
    trigger: 'pre_compact',
    title: 'Architecture decision',
    reasoning: 'We chose pattern X because it handles concurrency better',
    importance: 4,
    decisions: ['Use pattern X'],
    ...overrides,
  };
}

function makeConsensus(overrides: Partial<ConsensusDecision> = {}): ConsensusDecision {
  return {
    session_id: 'test-sess-001',
    timestamp: '2026-02-15T10:30:00.000Z',
    timestamp_epoch: 1739612600000,
    title: 'TCP vs stdin for sidecar IPC',
    description: 'Decided to use TCP sockets for hologram sidecar communication',
    status: 'agreed',
    importance: 4,
    claude_position: 'TCP is more reliable',
    codex_position: 'Agrees with TCP approach',
    human_verdict: 'Approved TCP',
    tags: ['architecture', 'hologram'],
    files_affected: ['src/hologram/sidecar.ts'],
    ...overrides,
  };
}

function projectScope(tmpDir: string): Scope {
  return { type: 'project', name: 'test-project', path: tmpDir };
}

// =============================================================================
// Tests
// =============================================================================

describe('Flat File Sync E2E', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Observation mirrors
  // ===========================================================================

  describe('observation mirrors', () => {
    it('creates daily observation file for project scope', () => {
      const scope = projectScope(tmpDir);
      mirrorObservation(makeObservation(), scope);

      const filePath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('Found database module');
      expect(content).toContain('discovery');
      expect(content).toContain('Importance');
      expect(content).toContain('3/5');
      expect(content).toContain('SQLite with FTS5');
    });

    it('appends multiple observations to the same daily file', () => {
      const scope = projectScope(tmpDir);

      mirrorObservation(makeObservation({ title: 'First observation' }), scope);
      mirrorObservation(makeObservation({
        title: 'Second observation',
        category: 'bugfix',
        content: 'Fixed the null pointer issue',
      }), scope);

      const filePath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('First observation');
      expect(content).toContain('Second observation');
      expect(content).toContain('bugfix');
      expect(content).toContain('Fixed the null pointer issue');
    });

    it('creates separate files for different dates', () => {
      const scope = projectScope(tmpDir);

      mirrorObservation(makeObservation({
        timestamp: '2026-02-15T10:00:00.000Z',
        title: 'Day one',
      }), scope);
      mirrorObservation(makeObservation({
        timestamp: '2026-02-16T14:00:00.000Z',
        title: 'Day two',
      }), scope);

      const file1 = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      const file2 = path.join(tmpDir, 'context', 'observations', '2026-02-16.md');

      expect(fs.existsSync(file1)).toBe(true);
      expect(fs.existsSync(file2)).toBe(true);

      expect(fs.readFileSync(file1, 'utf-8')).toContain('Day one');
      expect(fs.readFileSync(file1, 'utf-8')).not.toContain('Day two');
      expect(fs.readFileSync(file2, 'utf-8')).toContain('Day two');
    });

    it('includes files_read and files_modified when present', () => {
      const scope = projectScope(tmpDir);

      mirrorObservation(makeObservation({
        files_read: ['src/db/schema.ts'],
        files_modified: ['src/db/migrations.ts'],
      }), scope);

      const filePath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('src/db/schema.ts');
      expect(content).toContain('src/db/migrations.ts');
    });

    it('omits files line when no files present', () => {
      const scope = projectScope(tmpDir);

      mirrorObservation(makeObservation(), scope);

      const filePath = path.join(tmpDir, 'context', 'observations', '2026-02-15.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).not.toContain('**Files**:');
    });

    it('does not throw on write failure (silently handles errors)', () => {
      // Scope with an invalid path that can't be created
      const badScope: Scope = { type: 'project', name: 'bad', path: '' };

      // Should not throw — mirror functions never throw
      expect(() => mirrorObservation(makeObservation(), badScope)).not.toThrow();
    });
  });

  // ===========================================================================
  // Reasoning mirrors
  // ===========================================================================

  describe('reasoning mirrors', () => {
    it('creates reasoning file in project context directory', () => {
      const scope = projectScope(tmpDir);
      mirrorReasoning(makeReasoning(), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      expect(fs.existsSync(reasoningDir)).toBe(true);

      const files = fs.readdirSync(reasoningDir);
      expect(files).toHaveLength(1);

      const content = fs.readFileSync(path.join(reasoningDir, files[0]!), 'utf-8');
      expect(content).toContain('# Architecture decision');
      expect(content).toContain('pattern X');
      expect(content).toContain('pre_compact');
      expect(content).toContain('test-sess-001');
      expect(content).toContain('4/5');
    });

    it('includes decisions list in output', () => {
      const scope = projectScope(tmpDir);
      mirrorReasoning(makeReasoning({
        decisions: ['Use TCP socket', 'Defer vectors to Phase 4'],
      }), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      const files = fs.readdirSync(reasoningDir);
      const content = fs.readFileSync(path.join(reasoningDir, files[0]!), 'utf-8');

      expect(content).toContain('- Use TCP socket');
      expect(content).toContain('- Defer vectors to Phase 4');
    });

    it('includes files_involved in output', () => {
      const scope = projectScope(tmpDir);
      mirrorReasoning(makeReasoning({
        files_involved: ['src/hologram/sidecar.ts', 'src/db/schema.ts'],
      }), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      const files = fs.readdirSync(reasoningDir);
      const content = fs.readFileSync(path.join(reasoningDir, files[0]!), 'utf-8');

      expect(content).toContain('- src/hologram/sidecar.ts');
      expect(content).toContain('- src/db/schema.ts');
    });

    it('shows "None recorded" when decisions are empty', () => {
      const scope = projectScope(tmpDir);
      mirrorReasoning(makeReasoning({ decisions: undefined }), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      const files = fs.readdirSync(reasoningDir);
      const content = fs.readFileSync(path.join(reasoningDir, files[0]!), 'utf-8');

      expect(content).toContain('None recorded');
    });

    it('creates separate files for different reasoning chains', () => {
      const scope = projectScope(tmpDir);

      mirrorReasoning(makeReasoning({
        timestamp: '2026-02-15T10:00:00.000Z',
        title: 'First decision',
      }), scope);
      mirrorReasoning(makeReasoning({
        timestamp: '2026-02-15T11:00:00.000Z',
        title: 'Second decision',
      }), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      const files = fs.readdirSync(reasoningDir);
      expect(files).toHaveLength(2);
    });

    it('uses sanitized title in filename', () => {
      const scope = projectScope(tmpDir);
      mirrorReasoning(makeReasoning({
        title: 'Why we chose TCP/IP over stdin',
      }), scope);

      const reasoningDir = path.join(tmpDir, 'context', 'reasoning', 'test-sess-001');
      const files = fs.readdirSync(reasoningDir);
      const filename = files[0]!;

      // Slashes and special chars should be replaced
      expect(filename).not.toContain('/');
      expect(filename).toContain('Why-we-chose-TCP');
      expect(filename).toMatch(/\.md$/);
    });

    it('does not throw on write failure', () => {
      const badScope: Scope = { type: 'project', name: 'bad', path: '' };
      expect(() => mirrorReasoning(makeReasoning(), badScope)).not.toThrow();
    });
  });

  // ===========================================================================
  // Consensus mirrors
  // ===========================================================================

  describe('consensus mirrors', () => {
    it('creates consensus file in project context directory', () => {
      const scope = projectScope(tmpDir);
      mirrorConsensus(makeConsensus(), scope);

      const consensusDir = path.join(tmpDir, 'context', 'consensus', 'test-sess-001');
      expect(fs.existsSync(consensusDir)).toBe(true);

      const files = fs.readdirSync(consensusDir);
      expect(files).toHaveLength(1);

      const content = fs.readFileSync(path.join(consensusDir, files[0]!), 'utf-8');
      expect(content).toContain('# TCP vs stdin for sidecar IPC');
      expect(content).toContain('TCP sockets');
      expect(content).toContain('agreed');
      expect(content).toContain('4/5');
    });

    it('includes positions and human verdict', () => {
      const scope = projectScope(tmpDir);
      mirrorConsensus(makeConsensus(), scope);

      const consensusDir = path.join(tmpDir, 'context', 'consensus', 'test-sess-001');
      const files = fs.readdirSync(consensusDir);
      const content = fs.readFileSync(path.join(consensusDir, files[0]!), 'utf-8');

      expect(content).toContain('TCP is more reliable');
      expect(content).toContain('Agrees with TCP approach');
      expect(content).toContain('Approved TCP');
    });

    it('shows "Not recorded" when positions are missing', () => {
      const scope = projectScope(tmpDir);
      mirrorConsensus(makeConsensus({
        claude_position: undefined,
        codex_position: undefined,
        human_verdict: undefined,
      }), scope);

      const consensusDir = path.join(tmpDir, 'context', 'consensus', 'test-sess-001');
      const files = fs.readdirSync(consensusDir);
      const content = fs.readFileSync(path.join(consensusDir, files[0]!), 'utf-8');

      expect(content).toContain('Not recorded');
    });

    it('includes tags and files_affected', () => {
      const scope = projectScope(tmpDir);
      mirrorConsensus(makeConsensus(), scope);

      const consensusDir = path.join(tmpDir, 'context', 'consensus', 'test-sess-001');
      const files = fs.readdirSync(consensusDir);
      const content = fs.readFileSync(path.join(consensusDir, files[0]!), 'utf-8');

      expect(content).toContain('architecture');
      expect(content).toContain('hologram');
      expect(content).toContain('src/hologram/sidecar.ts');
    });

    it('shows "None" when tags and files_affected are absent', () => {
      const scope = projectScope(tmpDir);
      mirrorConsensus(makeConsensus({
        tags: undefined,
        files_affected: undefined,
      }), scope);

      const consensusDir = path.join(tmpDir, 'context', 'consensus', 'test-sess-001');
      const files = fs.readdirSync(consensusDir);
      const content = fs.readFileSync(path.join(consensusDir, files[0]!), 'utf-8');

      // "None" appears for both empty tags and empty files_affected
      const noneCount = (content.match(/\bNone\b/g) || []).length;
      expect(noneCount).toBeGreaterThanOrEqual(2);
    });

    it('does not throw on write failure', () => {
      const badScope: Scope = { type: 'project', name: 'bad', path: '' };
      expect(() => mirrorConsensus(makeConsensus(), badScope)).not.toThrow();
    });
  });

  // ===========================================================================
  // Pressure score mirrors
  // ===========================================================================

  describe('pressure score mirrors', () => {
    it('creates pressure scores snapshot file', () => {
      const scope = projectScope(tmpDir);
      const scores: PressureScore[] = [
        { file_path: 'src/main.ts', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 },
        { file_path: 'src/util.ts', raw_pressure: 0.5, temperature: 'WARM', decay_rate: 0.05 },
        { file_path: 'src/old.ts', raw_pressure: 0.1, temperature: 'COLD', decay_rate: 0.01 },
      ];

      mirrorPressureScores(scores, scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Pressure Scores');
      expect(content).toContain('src/main.ts');
      expect(content).toContain('HOT');
      expect(content).toContain('src/util.ts');
      expect(content).toContain('WARM');
      expect(content).toContain('src/old.ts');
      expect(content).toContain('COLD');
    });

    it('formats pressure and decay_rate to 3 decimal places', () => {
      const scope = projectScope(tmpDir);
      const scores: PressureScore[] = [
        { file_path: 'src/a.ts', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 },
      ];

      mirrorPressureScores(scores, scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(content).toContain('0.900');
      expect(content).toContain('0.050');
    });

    it('renders markdown table structure', () => {
      const scope = projectScope(tmpDir);
      const scores: PressureScore[] = [
        { file_path: 'src/a.ts', raw_pressure: 0.8, temperature: 'HOT', decay_rate: 0.03 },
      ];

      mirrorPressureScores(scores, scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Verify markdown table headers
      expect(content).toContain('| File | Pressure | Decay Rate |');
      expect(content).toContain('|------|----------|------------|');
    });

    it('overwrites pressure file on subsequent calls (snapshot, not append)', () => {
      const scope = projectScope(tmpDir);

      const firstScores: PressureScore[] = [
        { file_path: 'src/old-file.ts', raw_pressure: 0.9, temperature: 'HOT', decay_rate: 0.05 },
      ];
      mirrorPressureScores(firstScores, scope);

      const secondScores: PressureScore[] = [
        { file_path: 'src/new-file.ts', raw_pressure: 0.3, temperature: 'COLD', decay_rate: 0.01 },
      ];
      mirrorPressureScores(secondScores, scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Only second call's data should be present
      expect(content).toContain('src/new-file.ts');
      expect(content).not.toContain('src/old-file.ts');
    });

    it('handles empty scores array', () => {
      const scope = projectScope(tmpDir);
      mirrorPressureScores([], scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).toContain('# Pressure Scores');
      // Tables should exist but have no data rows
      expect(content).toContain('## HOT Files');
      expect(content).toContain('## WARM Files');
      expect(content).toContain('## COLD Files');
    });

    it('groups scores by temperature level', () => {
      const scope = projectScope(tmpDir);
      const scores: PressureScore[] = [
        { file_path: 'hot1.ts', raw_pressure: 0.95, temperature: 'HOT', decay_rate: 0.05 },
        { file_path: 'hot2.ts', raw_pressure: 0.85, temperature: 'HOT', decay_rate: 0.04 },
        { file_path: 'warm1.ts', raw_pressure: 0.5, temperature: 'WARM', decay_rate: 0.03 },
        { file_path: 'cold1.ts', raw_pressure: 0.1, temperature: 'COLD', decay_rate: 0.01 },
      ];

      mirrorPressureScores(scores, scope);

      const filePath = path.join(tmpDir, 'context', 'pressure', 'scores.md');
      const content = fs.readFileSync(filePath, 'utf-8');

      // HOT section should contain both hot files
      const hotSection = content.split('## WARM Files')[0]!;
      expect(hotSection).toContain('hot1.ts');
      expect(hotSection).toContain('hot2.ts');
      expect(hotSection).not.toContain('warm1.ts');

      // WARM section should contain warm file
      const warmSection = content.split('## WARM Files')[1]!.split('## COLD Files')[0]!;
      expect(warmSection).toContain('warm1.ts');
      expect(warmSection).not.toContain('hot1.ts');
    });

    it('does not throw on write failure', () => {
      const badScope: Scope = { type: 'project', name: 'bad', path: '' };
      expect(() => mirrorPressureScores([], badScope)).not.toThrow();
    });
  });

  // ===========================================================================
  // sanitizeFilename
  // ===========================================================================

  describe('sanitizeFilename', () => {
    it('replaces special characters with hyphens', () => {
      expect(sanitizeFilename('hello/world:test')).toBe('hello-world-test');
    });

    it('replaces spaces with hyphens', () => {
      expect(sanitizeFilename('hello world')).toBe('hello-world');
    });

    it('collapses consecutive hyphens', () => {
      expect(sanitizeFilename('a///b')).toBe('a-b');
    });

    it('strips leading and trailing hyphens', () => {
      expect(sanitizeFilename('/hello/')).toBe('hello');
    });

    it('truncates to 50 characters', () => {
      const long = 'a'.repeat(60);
      expect(sanitizeFilename(long).length).toBeLessThanOrEqual(50);
    });

    it('preserves safe characters', () => {
      expect(sanitizeFilename('hello_world-test.txt')).toBe('hello_world-test.txt');
    });
  });
});
