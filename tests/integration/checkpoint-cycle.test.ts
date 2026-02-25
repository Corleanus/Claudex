import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { writeCheckpoint } from '../../src/checkpoint/writer.js';
import { loadLatestCheckpoint } from '../../src/checkpoint/loader.js';
import { appendDecision, appendExchange, recordFileTouch, readDecisions, readThread } from '../../src/checkpoint/state-files.js';
import { RESUME_LOAD } from '../../src/checkpoint/types.js';
import type { GaugeReading } from '../../src/lib/token-gauge.js';

describe('checkpoint cycle (E2E)', () => {
  let tmpDir: string;
  const sessionId = 'test-session-e2e';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('full cycle: accumulate → write → reload → verify', () => {
    // Phase 1: Accumulate incremental state
    appendDecision(tmpDir, sessionId, {
      id: 'd1',
      what: 'Use stratified decay',
      why: 'Different importance tiers need different half-lives',
      when: new Date().toISOString(),
      reversible: true,
    });

    appendDecision(tmpDir, sessionId, {
      id: 'd2',
      what: 'Cap thread at 20 exchanges',
      why: 'Prevent unbounded growth',
      when: new Date().toISOString(),
      reversible: true,
    });

    appendExchange(tmpDir, sessionId, { role: 'user', gist: 'Implement decay engine' });
    appendExchange(tmpDir, sessionId, { role: 'agent', gist: 'Created decay-engine.ts with EI formula' });

    recordFileTouch(tmpDir, sessionId, 'src/lib/decay-engine.ts', 'created', 'EI computation module');

    // Verify state accumulated
    const decisions = readDecisions(tmpDir, sessionId);
    expect(decisions).toHaveLength(2);
    const thread = readThread(tmpDir, sessionId);
    expect(thread.key_exchanges).toHaveLength(2);

    // Phase 2: Write checkpoint
    const gauge: GaugeReading = {
      status: 'ok',
      usage: {
        input_tokens: 162000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      window_size: 200000,
      utilization: 0.81,
      threshold: 'checkpoint',
      formatted: '[████████░░ 81% | 162k/200k]',
    };

    const result = writeCheckpoint({
      projectDir: tmpDir,
      sessionId,
      scope: 'project:test',
      trigger: 'auto-80pct',
      gaugeReading: gauge,
    });

    expect(result).not.toBeNull();
    expect(result!.checkpointId).toMatch(/^\d{4}-\d{2}-\d{2}_cp\d+$/);

    // Verify checkpoint file exists
    const latestPath = path.join(tmpDir, 'context', 'checkpoints', 'latest.yaml');
    expect(fs.existsSync(latestPath)).toBe(true);

    // Verify state was archived (state dir renamed)
    const stateDir = path.join(tmpDir, 'context', 'state', sessionId);
    expect(fs.existsSync(stateDir)).toBe(false);

    // Phase 3: Reload checkpoint
    const loaded = loadLatestCheckpoint(tmpDir, {
      sections: RESUME_LOAD,
      resumeMode: true,
    });

    expect(loaded).not.toBeNull();

    // Phase 4: Verify data survived
    expect(loaded!.checkpoint.decisions).toHaveLength(2);
    expect(loaded!.checkpoint.decisions[0]!.what).toBe('Use stratified decay');
    expect(loaded!.checkpoint.decisions[1]!.what).toBe('Cap thread at 20 exchanges');

    expect(loaded!.checkpoint.thread.key_exchanges).toHaveLength(2);
    expect(loaded!.checkpoint.thread.key_exchanges[0]!.gist).toBe('Implement decay engine');

    expect(loaded!.checkpoint.files.changed).toHaveLength(1);
    expect(loaded!.checkpoint.files.changed[0]!.path).toBe('src/lib/decay-engine.ts');

    expect(loaded!.checkpoint.meta.token_usage.utilization).toBeCloseTo(0.81, 1);
    expect(loaded!.checkpoint.working.status).toBe('in_progress');
  });

  it('checkpoint chain: write two checkpoints, both loadable', () => {
    // First checkpoint
    appendDecision(tmpDir, sessionId, {
      id: 'd1', what: 'First decision', why: 'Reason 1',
      when: new Date().toISOString(), reversible: true,
    });

    const gauge1: GaugeReading = {
      status: 'ok',
      usage: {
        input_tokens: 160000,
        output_tokens: 4000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      window_size: 200000,
      utilization: 0.80,
      threshold: 'checkpoint',
      formatted: '[████████░░ 80%]',
    };

    const r1 = writeCheckpoint({ projectDir: tmpDir, sessionId, scope: 'project:test', trigger: 'auto-80pct', gaugeReading: gauge1 });
    expect(r1).not.toBeNull();

    // Second checkpoint (new state dir created fresh after archive)
    appendDecision(tmpDir, sessionId, {
      id: 'd2', what: 'Second decision', why: 'Reason 2',
      when: new Date().toISOString(), reversible: true,
    });

    const gauge2: GaugeReading = {
      status: 'ok',
      usage: {
        input_tokens: 170000,
        output_tokens: 5000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      window_size: 200000,
      utilization: 0.85,
      threshold: 'checkpoint',
      formatted: '[█████████░ 85%]',
    };

    const r2 = writeCheckpoint({ projectDir: tmpDir, sessionId, scope: 'project:test', trigger: 'auto-80pct', gaugeReading: gauge2 });
    expect(r2).not.toBeNull();

    // Load latest — should be r2
    const loaded = loadLatestCheckpoint(tmpDir, { sections: RESUME_LOAD, resumeMode: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoint.meta.checkpoint_id).toBe(r2!.checkpointId);

    // Should have previous_checkpoint linking to r1
    expect(loaded!.checkpoint.meta.previous_checkpoint).toContain('cp');
  });

  it('empty state produces valid checkpoint with empty sections', () => {
    const gauge: GaugeReading = {
      status: 'ok',
      usage: {
        input_tokens: 165000,
        output_tokens: 3000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      window_size: 200000,
      utilization: 0.825,
      threshold: 'checkpoint',
      formatted: '[████████░░ 83%]',
    };

    const result = writeCheckpoint({ projectDir: tmpDir, sessionId, scope: 'global', trigger: 'manual', gaugeReading: gauge });
    expect(result).not.toBeNull();

    const loaded = loadLatestCheckpoint(tmpDir, { sections: RESUME_LOAD, resumeMode: true });
    expect(loaded).not.toBeNull();
    expect(loaded!.checkpoint.decisions).toHaveLength(0);
    expect(loaded!.checkpoint.thread.key_exchanges).toHaveLength(0);
    expect(loaded!.checkpoint.files.changed).toHaveLength(0);
  });
});
