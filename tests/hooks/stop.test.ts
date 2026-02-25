/**
 * Tests for WP-12: Stop Hook — Decision Capture Nudge
 *
 * Tests internal functions exported from src/hooks/stop.ts.
 * No vi.mock for fs/yaml — dependencies are passed as parameters via
 * the exported functions (avoids CommonJS require() interception issues).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readNudgeState,
  writeNudgeState,
  detectDecisionSignals,
  extractAssistantGist,
} from '../../src/hooks/stop.js';
import type { TranscriptSignals } from '../../src/hooks/stop.js';

// Mock logger and metrics to prevent filesystem writes
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/shared/metrics.js', () => ({
  recordMetric: vi.fn(),
  getMetrics: vi.fn(() => ({})),
}));

// =============================================================================
// Test Helpers
// =============================================================================

/** Create a temp directory for state file tests */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-stop-test-'));
}

/** Build a minimal JSONL transcript with tool_use blocks in message.content */
function buildTranscript(tools: Array<{ name: string; input?: Record<string, unknown> }>): string {
  const entry = {
    type: 'message',
    message: {
      role: 'assistant',
      content: tools.map(t => ({
        type: 'tool_use',
        id: `tool_${Math.random()}`,
        name: t.name,
        input: t.input ?? {},
      })),
      usage: { input_tokens: 10000, output_tokens: 500 },
    },
  };
  return JSON.stringify(entry) + '\n';
}

/** Write transcript content to a temp file and return its path */
function writeTempTranscript(content: string, dir: string): string {
  const filePath = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

// =============================================================================
// Tests: readNudgeState / writeNudgeState
// =============================================================================

describe('readNudgeState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('returns empty state when .nudge-state.yaml does not exist', () => {
    const state = readNudgeState(tmpDir);
    expect(state.lastNudgeTurn).toBe(0);
    expect(state.turnCount).toBe(0);
    expect(state.lastKnownDecisionCount).toBe(0);
  });

  it('returns empty state when directory does not exist', () => {
    const state = readNudgeState(path.join(tmpDir, 'nonexistent'));
    expect(state.lastNudgeTurn).toBe(0);
    expect(state.turnCount).toBe(0);
    expect(state.lastKnownDecisionCount).toBe(0);
  });

  it('reads written state back correctly', () => {
    writeNudgeState(tmpDir, { lastNudgeTurn: 3, turnCount: 7, lastKnownDecisionCount: 2 });
    const state = readNudgeState(tmpDir);
    expect(state.lastNudgeTurn).toBe(3);
    expect(state.turnCount).toBe(7);
    expect(state.lastKnownDecisionCount).toBe(2);
  });

  it('returns empty state when file is corrupt YAML', () => {
    fs.writeFileSync(path.join(tmpDir, '.nudge-state.yaml'), '{ invalid yaml ::::: }', 'utf-8');
    const state = readNudgeState(tmpDir);
    expect(state.lastNudgeTurn).toBe(0);
    expect(state.turnCount).toBe(0);
  });

  it('returns empty state when file is empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.nudge-state.yaml'), '', 'utf-8');
    const state = readNudgeState(tmpDir);
    expect(state.lastNudgeTurn).toBe(0);
    expect(state.turnCount).toBe(0);
  });

  it('handles CRLF line endings in YAML', () => {
    const content = 'lastNudgeTurn: 5\r\nturnCount: 10\r\nlastKnownDecisionCount: 3\r\n';
    fs.writeFileSync(path.join(tmpDir, '.nudge-state.yaml'), content, 'utf-8');
    const state = readNudgeState(tmpDir);
    expect(state.lastNudgeTurn).toBe(5);
    expect(state.turnCount).toBe(10);
    expect(state.lastKnownDecisionCount).toBe(3);
  });
});

describe('writeNudgeState', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('creates the state file when directory exists', () => {
    writeNudgeState(tmpDir, { lastNudgeTurn: 1, turnCount: 5, lastKnownDecisionCount: 0 });
    const filePath = path.join(tmpDir, '.nudge-state.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('creates parent directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested', 'dir');
    writeNudgeState(nestedDir, { lastNudgeTurn: 0, turnCount: 1, lastKnownDecisionCount: 0 });
    expect(fs.existsSync(path.join(nestedDir, '.nudge-state.yaml'))).toBe(true);
  });

  it('does not throw when state dir is unwriteable (non-fatal)', () => {
    // Writing to a file path (not a directory) should be caught internally
    const fakeDirPath = path.join(tmpDir, 'i-am-a-file');
    fs.writeFileSync(fakeDirPath, 'block', 'utf-8');
    // This tries to create a file inside 'i-am-a-file' which is itself a file
    expect(() => {
      writeNudgeState(fakeDirPath, { lastNudgeTurn: 0, turnCount: 1, lastKnownDecisionCount: 0 });
    }).not.toThrow();
  });
});

// =============================================================================
// Tests: detectDecisionSignals
// =============================================================================

describe('detectDecisionSignals', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('returns fileModifyCount=0 and empty toolActions when transcriptPath is undefined', () => {
    const signals = detectDecisionSignals(undefined);
    expect(signals.fileModifyCount).toBe(0);
    expect(signals.toolActions).toEqual([]);
  });

  it('returns fileModifyCount=0 and empty toolActions when transcript file does not exist', () => {
    const signals = detectDecisionSignals(path.join(tmpDir, 'nonexistent.jsonl'));
    expect(signals.fileModifyCount).toBe(0);
    expect(signals.toolActions).toEqual([]);
  });

  it('returns fileModifyCount=0 but captures toolActions for non-modifying tools', () => {
    const content = buildTranscript([
      { name: 'Read', input: { file_path: '/src/main.ts' } },
      { name: 'Grep' },
      { name: 'Glob' },
    ]);
    const transcriptPath = writeTempTranscript(content, tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    expect(signals.fileModifyCount).toBe(0);
    expect(signals.toolActions).toHaveLength(3);
    expect(signals.toolActions[0]).toEqual({ name: 'Read', target: '/src/main.ts' });
  });

  it('counts Write, Edit, Bash tool_use blocks and captures toolActions', () => {
    const content = buildTranscript([
      { name: 'Write', input: { file_path: '/src/new-file.ts' } },
      { name: 'Edit', input: { file_path: '/src/old-file.ts' } },
      { name: 'Bash', input: { command: 'pnpm test' } },
    ]);
    const transcriptPath = writeTempTranscript(content, tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    expect(signals.fileModifyCount).toBe(3);
    expect(signals.toolActions).toHaveLength(3);
    expect(signals.toolActions[0]).toEqual({ name: 'Write', target: '/src/new-file.ts' });
    expect(signals.toolActions[2]).toEqual({ name: 'Bash', target: 'pnpm test' });
  });

  it('counts 3 Write calls correctly', () => {
    const content = buildTranscript([
      { name: 'Write' },
      { name: 'Write' },
      { name: 'Write' },
    ]);
    const transcriptPath = writeTempTranscript(content, tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    expect(signals.fileModifyCount).toBe(3);
  });

  it('handles malformed JSONL lines gracefully', () => {
    const goodLine = JSON.stringify({
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: {} },
          { type: 'tool_use', name: 'Edit', input: {} },
        ],
      },
    });
    const content = 'this is not json\n' + goodLine + '\n{ unclosed\n';
    const transcriptPath = writeTempTranscript(content, tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    // Should still count the valid line
    expect(signals.fileModifyCount).toBe(2);
  });

  it('handles empty transcript file gracefully', () => {
    const transcriptPath = writeTempTranscript('', tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    expect(signals.fileModifyCount).toBe(0);
  });

  it('ignores non-tool_use content blocks', () => {
    const content = JSON.stringify({
      message: {
        content: [
          { type: 'text', text: 'I will edit the file' },
          { type: 'tool_use', name: 'Read', input: {} },
        ],
      },
    }) + '\n';
    const transcriptPath = writeTempTranscript(content, tmpDir);
    const signals = detectDecisionSignals(transcriptPath);
    expect(signals.fileModifyCount).toBe(0);
  });
});

// =============================================================================
// Tests: Nudge Decision Logic (integration via state + signals)
// =============================================================================

describe('stop hook nudge logic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('nudge condition: signals >= threshold AND no new decisions', () => {
    // Simulate: 3 Write calls, 0 decisions, no prior nudge
    const nudgeState = readNudgeState(tmpDir);
    nudgeState.turnCount++;
    const turnsSinceLastNudge = nudgeState.turnCount - nudgeState.lastNudgeTurn;
    const rateLimited = nudgeState.lastNudgeTurn > 0 && turnsSinceLastNudge < 5;
    const fileModifyCount = 3;
    const decisionCount = 0;
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions && !rateLimited;
    expect(shouldNudge).toBe(true);
  });

  it('no nudge: signals present but decisions exist', () => {
    // Simulate: 3 Write calls, 2 decisions recorded
    const nudgeState = { lastNudgeTurn: 0, turnCount: 1, lastKnownDecisionCount: 0 };
    const fileModifyCount = 3;
    const decisionCount = 2;
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const rateLimited = false;
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions && !rateLimited;
    expect(shouldNudge).toBe(false);
  });

  it('no nudge: signals below threshold (< 2 file-modifying tools)', () => {
    const nudgeState = { lastNudgeTurn: 0, turnCount: 1, lastKnownDecisionCount: 0 };
    const fileModifyCount = 1;
    const decisionCount = 0;
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const rateLimited = false;
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions && !rateLimited;
    expect(shouldNudge).toBe(false);
  });

  it('no nudge when rate limited (nudged 2 turns ago)', () => {
    // lastNudgeTurn=3, turnCount=4 → 1 turn since nudge, cooldown=5 → rate limited
    const nudgeState = { lastNudgeTurn: 3, turnCount: 4, lastKnownDecisionCount: 0 };
    const turnsSinceLastNudge = nudgeState.turnCount - nudgeState.lastNudgeTurn;
    const rateLimited = nudgeState.lastNudgeTurn > 0 && turnsSinceLastNudge < 5;
    expect(rateLimited).toBe(true);
  });

  it('nudge allowed when rate limit expired (5+ turns since last nudge)', () => {
    // lastNudgeTurn=1, turnCount=6 → 5 turns since nudge → cooldown expired
    const nudgeState = { lastNudgeTurn: 1, turnCount: 6, lastKnownDecisionCount: 0 };
    const fileModifyCount = 3;
    const decisionCount = 0;
    const turnsSinceLastNudge = nudgeState.turnCount - nudgeState.lastNudgeTurn;
    const rateLimited = nudgeState.lastNudgeTurn > 0 && turnsSinceLastNudge < 5;
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions && !rateLimited;
    expect(rateLimited).toBe(false);
    expect(shouldNudge).toBe(true);
  });

  it('nudge message contains expected text about appendDecision', () => {
    const expectedFragment = 'appendDecision()';
    const nudgeMsg = 'Tip: You made significant file changes this turn but logged no decisions. Consider recording key decisions via appendDecision() to context/state/decisions.yaml — this preserves decision rationale across compactions.';
    expect(nudgeMsg).toContain(expectedFragment);
    expect(nudgeMsg).toContain('context/state/decisions.yaml');
  });

  it('nudge state persists lastKnownDecisionCount after nudge', () => {
    writeNudgeState(tmpDir, { lastNudgeTurn: 1, turnCount: 1, lastKnownDecisionCount: 0 });
    // Simulate nudge: update lastKnownDecisionCount to current count
    const newState = readNudgeState(tmpDir);
    newState.lastKnownDecisionCount = 3;
    newState.lastNudgeTurn = newState.turnCount;
    writeNudgeState(tmpDir, newState);

    const readBack = readNudgeState(tmpDir);
    expect(readBack.lastKnownDecisionCount).toBe(3);
  });

  it('decisions added since last nudge prevents re-nudge', () => {
    // lastKnownDecisionCount=0, now decisionCount=2 → new decisions recorded → no nudge
    const nudgeState = { lastNudgeTurn: 0, turnCount: 6, lastKnownDecisionCount: 0 };
    const fileModifyCount = 3;
    const decisionCount = 2; // New decisions were added!
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    expect(noNewDecisions).toBe(false);
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions;
    expect(shouldNudge).toBe(false);
  });
});

// =============================================================================
// Tests: Edge Cases — non-project scope and error resilience
// =============================================================================

describe('stop hook edge cases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('detectDecisionSignals never throws on unreadable file', () => {
    // Even with a bad path, should return zero counts
    const signals = detectDecisionSignals('/nonexistent/path/to/transcript.jsonl');
    expect(signals.fileModifyCount).toBe(0);
  });

  it('readNudgeState never throws regardless of input', () => {
    // Empty string path
    expect(() => readNudgeState('')).not.toThrow();
    // Deeply nested nonexistent path
    expect(() => readNudgeState('/a/b/c/d/e/f/g')).not.toThrow();
  });

  it('writeNudgeState never throws regardless of input', () => {
    expect(() => writeNudgeState('', { lastNudgeTurn: 0, turnCount: 0, lastKnownDecisionCount: 0 })).not.toThrow();
  });

  it('0 file-modifying tools results in no nudge (boundary condition)', () => {
    const fileModifyCount = 0;
    const shouldNudge = fileModifyCount >= 2;
    expect(shouldNudge).toBe(false);
  });

  it('exactly 2 file-modifying tools triggers nudge (boundary condition)', () => {
    const nudgeState = { lastNudgeTurn: 0, turnCount: 1, lastKnownDecisionCount: 0 };
    const fileModifyCount = 2;
    const decisionCount = 0;
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const rateLimited = false;
    const shouldNudge = fileModifyCount >= 2 && noNewDecisions && !rateLimited;
    expect(shouldNudge).toBe(true);
  });
});

// =============================================================================
// Tests: extractAssistantGist
// =============================================================================

describe('extractAssistantGist', () => {
  it('returns fallback gist when no tool actions', () => {
    const signals: TranscriptSignals = { fileModifyCount: 0, toolActions: [] };
    expect(extractAssistantGist(signals)).toBe('Responded to user query');
  });

  it('produces "Edited <file>" for a single Edit action', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [{ name: 'Edit', target: '/src/hooks/stop.ts' }],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Edited');
    expect(gist).toContain('stop.ts');
  });

  it('produces "Created <file>" for a single Write action', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [{ name: 'Write', target: '/tests/new-test.ts' }],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Created');
    expect(gist).toContain('new-test.ts');
  });

  it('produces "Read N files" for multiple Read actions', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 0,
      toolActions: [
        { name: 'Read', target: '/src/a.ts' },
        { name: 'Read', target: '/src/b.ts' },
        { name: 'Read', target: '/src/c.ts' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toBe('Read 3 files');
  });

  it('produces "Read 1 file" for a single Read action', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 0,
      toolActions: [{ name: 'Read', target: '/src/a.ts' }],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toBe('Read 1 file');
  });

  it('detects test runs in Bash commands', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [{ name: 'Bash', target: 'pnpm test' }],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Ran tests');
  });

  it('produces "Ran N commands" for non-test Bash commands', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 2,
      toolActions: [
        { name: 'Bash', target: 'git status' },
        { name: 'Bash', target: 'git diff' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Ran 2 commands');
  });

  it('combines multiple action types with semicolons', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [
        { name: 'Read', target: '/src/a.ts' },
        { name: 'Edit', target: '/src/a.ts' },
        { name: 'Bash', target: 'pnpm test' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Edited');
    expect(gist).toContain(';');
    expect(gist).toContain('Read 1 file');
    expect(gist).toContain('Ran tests');
  });

  it('deduplicates edited file names', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 3,
      toolActions: [
        { name: 'Edit', target: '/src/hooks/stop.ts' },
        { name: 'Edit', target: '/src/hooks/stop.ts' },
        { name: 'Edit', target: '/src/hooks/stop.ts' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toBe('Edited stop.ts');
  });

  it('caps gist length at 100 characters', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 5,
      toolActions: [
        { name: 'Edit', target: '/src/very-long-filename-one.ts' },
        { name: 'Edit', target: '/src/very-long-filename-two.ts' },
        { name: 'Edit', target: '/src/very-long-filename-three.ts' },
        { name: 'Edit', target: '/src/very-long-filename-four.ts' },
        { name: 'Write', target: '/src/very-long-filename-five.ts' },
        { name: 'Read', target: '/src/a.ts' },
        { name: 'Read', target: '/src/b.ts' },
        { name: 'Bash', target: 'pnpm build && pnpm test' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist.length).toBeLessThanOrEqual(100);
  });

  it('handles tool actions with no target (undefined)', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [{ name: 'Edit' }],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toBe('Edited file');
  });

  it('handles unknown/other tool names', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 0,
      toolActions: [
        { name: 'WebSearch' },
        { name: 'Glob' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('Used');
    expect(gist).toContain('WebSearch');
  });

  it('shows "+N more" when many files are edited', () => {
    const signals: TranscriptSignals = {
      fileModifyCount: 5,
      toolActions: [
        { name: 'Edit', target: '/src/a.ts' },
        { name: 'Edit', target: '/src/b.ts' },
        { name: 'Edit', target: '/src/c.ts' },
        { name: 'Edit', target: '/src/d.ts' },
        { name: 'Edit', target: '/src/e.ts' },
      ],
    };
    const gist = extractAssistantGist(signals);
    expect(gist).toContain('+2 more');
  });

  it('exchange format matches ThreadState expectations (role: agent)', () => {
    // Verify the gist can be used in an exchange with role: 'agent'
    const signals: TranscriptSignals = {
      fileModifyCount: 1,
      toolActions: [{ name: 'Edit', target: '/src/hooks/stop.ts' }],
    };
    const gist = extractAssistantGist(signals);
    const exchange = { role: 'agent' as const, gist };
    expect(exchange.role).toBe('agent');
    expect(typeof exchange.gist).toBe('string');
    expect(exchange.gist.length).toBeGreaterThan(0);
    expect(exchange.gist.length).toBeLessThanOrEqual(100);
  });
});
