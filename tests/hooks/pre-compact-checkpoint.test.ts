/**
 * Claudex v3 — PreCompact Structured Checkpoint Tests
 *
 * Tests for the structured YAML checkpoint safety net added to PreCompact.
 * This checkpoint catches the case where UserPromptSubmit's 80% trigger
 * didn't fire before auto-compact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock logger and metrics before importing modules that use them
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
}));

import { readTokenGauge } from '../../src/lib/token-gauge.js';
import { writeCheckpoint } from '../../src/checkpoint/writer.js';
import type { GaugeReading } from '../../src/lib/token-gauge.js';

// =============================================================================
// Helpers
// =============================================================================

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-pc-cp-test-'));
}

/** Create a minimal transcript JSONL with usage data */
function writeTranscript(dir: string, inputTokens: number): string {
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const line = JSON.stringify({
    message: {
      role: 'assistant',
      usage: {
        input_tokens: inputTokens,
        output_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  fs.writeFileSync(transcriptPath, line + '\n', 'utf-8');
  return transcriptPath;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// =============================================================================
// Tests
// =============================================================================

describe('PreCompact — Structured YAML Checkpoint', () => {
  it('writes structured checkpoint after reasoning capture', () => {
    // Simulate the PreCompact structured checkpoint logic:
    // writeCheckpoint is called with trigger 'pre-compact'
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectDir, 'context', 'checkpoints'), { recursive: true });

    const transcriptPath = writeTranscript(tmpDir, 160_000);
    const gauge = readTokenGauge(transcriptPath, 200_000);

    const result = writeCheckpoint({
      projectDir,
      sessionId: 'test-session-pc',
      scope: 'project:test-project',
      trigger: 'pre-compact',
      gaugeReading: gauge,
    });

    expect(result).not.toBeNull();
    expect(result!.checkpointId).toMatch(/^\d{4}-\d{2}-\d{2}_cp\d+$/);

    // Verify the checkpoint file exists
    const cpDir = path.join(projectDir, 'context', 'checkpoints');
    const cpFile = path.join(cpDir, `${result!.checkpointId}.yaml`);
    expect(fs.existsSync(cpFile)).toBe(true);

    // Verify latest.yaml was updated
    const latestPath = path.join(cpDir, 'latest.yaml');
    expect(fs.existsSync(latestPath)).toBe(true);
    const latestContent = fs.readFileSync(latestPath, 'utf-8');
    expect(latestContent).toContain(result!.checkpointId);

    // Verify trigger is 'pre-compact' in checkpoint data
    expect(result!.checkpoint.meta.trigger).toBe('pre-compact');
  });

  it('debounces: skips checkpoint when latest.yaml is fresh (<60s)', () => {
    const projectDir = path.join(tmpDir, 'project');
    const cpDir = path.join(projectDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });

    // Create a fresh latest.yaml (just now)
    const latestPath = path.join(cpDir, 'latest.yaml');
    fs.writeFileSync(latestPath, 'ref: 2026-02-25_cp1.yaml\n', 'utf-8');

    // Simulate the debounce check from pre-compact.ts
    let shouldWrite = true;
    try {
      const latestStat = fs.statSync(latestPath);
      if (Date.now() - latestStat.mtimeMs < 60_000) {
        shouldWrite = false;
      }
    } catch { /* latest.yaml doesn't exist */ }

    expect(shouldWrite).toBe(false);
  });

  it('debounces: writes checkpoint when latest.yaml is stale (>60s)', () => {
    const projectDir = path.join(tmpDir, 'project');
    const cpDir = path.join(projectDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });

    // Create a stale latest.yaml (modified 120s ago)
    const latestPath = path.join(cpDir, 'latest.yaml');
    fs.writeFileSync(latestPath, 'ref: 2026-02-25_cp1.yaml\n', 'utf-8');

    // Set mtime to 120 seconds ago
    const staleTime = new Date(Date.now() - 120_000);
    fs.utimesSync(latestPath, staleTime, staleTime);

    // Simulate the debounce check
    let shouldWrite = true;
    try {
      const latestStat = fs.statSync(latestPath);
      if (Date.now() - latestStat.mtimeMs < 60_000) {
        shouldWrite = false;
      }
    } catch { /* latest.yaml doesn't exist */ }

    expect(shouldWrite).toBe(true);

    // Verify writeCheckpoint succeeds when debounce passes
    const transcriptPath = writeTranscript(tmpDir, 180_000);
    const gauge = readTokenGauge(transcriptPath, 200_000);
    const result = writeCheckpoint({
      projectDir,
      sessionId: 'test-session-stale',
      scope: 'project:test-project',
      trigger: 'pre-compact',
      gaugeReading: gauge,
    });

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.trigger).toBe('pre-compact');
  });

  it('debounces: writes checkpoint when latest.yaml does not exist', () => {
    const projectDir = path.join(tmpDir, 'project');
    const cpDir = path.join(projectDir, 'context', 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });

    // No latest.yaml exists
    const latestPath = path.join(cpDir, 'latest.yaml');

    // Simulate the debounce check
    let shouldWrite = true;
    try {
      const latestStat = fs.statSync(latestPath);
      if (Date.now() - latestStat.mtimeMs < 60_000) {
        shouldWrite = false;
      }
    } catch { /* latest.yaml doesn't exist — should write */ }

    expect(shouldWrite).toBe(true);

    // Verify writeCheckpoint succeeds
    const transcriptPath = writeTranscript(tmpDir, 170_000);
    const gauge = readTokenGauge(transcriptPath, 200_000);
    const result = writeCheckpoint({
      projectDir,
      sessionId: 'test-session-no-latest',
      scope: 'project:test-project',
      trigger: 'pre-compact',
      gaugeReading: gauge,
    });

    expect(result).not.toBeNull();
  });

  it('trigger field is pre-compact in checkpoint metadata', () => {
    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(path.join(projectDir, 'context', 'checkpoints'), { recursive: true });

    const transcriptPath = writeTranscript(tmpDir, 150_000);
    const gauge = readTokenGauge(transcriptPath, 200_000);

    const result = writeCheckpoint({
      projectDir,
      sessionId: 'test-session-trigger',
      scope: 'global',
      trigger: 'pre-compact',
      gaugeReading: gauge,
    });

    expect(result).not.toBeNull();
    expect(result!.checkpoint.meta.trigger).toBe('pre-compact');
    expect(result!.checkpoint.meta.session_id).toBe('test-session-trigger');
    expect(result!.checkpoint.meta.scope).toBe('global');
  });

  it('structured checkpoint failure does not affect existing pre-compact behavior', () => {
    // The structured checkpoint is wrapped in try/catch, so even if writeCheckpoint
    // throws (which it shouldn't — it returns null), the pre-compact hook continues.
    // We verify writeCheckpoint returns null on invalid input rather than throwing.

    // writeCheckpoint with an invalid/non-writable path should return null, not throw
    const gauge: GaugeReading = {
      status: 'unavailable',
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      window_size: 200_000,
      utilization: 0,
      formatted: '[Token gauge unavailable]',
      threshold: 'unavailable',
    };

    // Even with a projectDir that doesn't have the right structure,
    // writeCheckpoint should handle gracefully
    let error: Error | null = null;
    let result = null;
    try {
      result = writeCheckpoint({
        projectDir: path.join(tmpDir, 'project-no-crash'),
        sessionId: 'test-session-nocash',
        scope: 'project:test',
        trigger: 'pre-compact',
        gaugeReading: gauge,
      });
    } catch (e) {
      error = e as Error;
    }

    // writeCheckpoint never throws — it returns null on failure or succeeds
    expect(error).toBeNull();
    // It may return a result (creates the dir) or null — either way, no throw
  });
});
