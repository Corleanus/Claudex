/**
 * Claudex v3 -- Checkpoint Formatter Tests
 *
 * Tests for src/checkpoint/formatter.ts.
 * Covers R03: formatAiderTrick handles missing/malformed fields without crashing.
 */

import { describe, it, expect } from 'vitest';
import type { Checkpoint } from '../../src/checkpoint/types.js';
import { CHECKPOINT_SCHEMA, CHECKPOINT_VERSION } from '../../src/checkpoint/types.js';
import { formatCheckpointForInjection } from '../../src/checkpoint/formatter.js';

// =============================================================================
// Helpers
// =============================================================================

function makeCheckpoint(overrides?: Partial<Checkpoint>): Checkpoint {
  return {
    schema: CHECKPOINT_SCHEMA,
    version: CHECKPOINT_VERSION,
    meta: {
      checkpoint_id: 'test-cp',
      session_id: 'test-session',
      scope: 'project:test',
      created_at: '2026-02-24T15:00:00Z',
      created_at_epoch_ms: 1740409200000,
      trigger: 'auto-80pct',
      writer_version: '3.0.0',
      token_usage: {
        input_tokens: 120000,
        output_tokens: 5000,
        window_size: 200000,
        utilization: 0.625,
      },
      previous_checkpoint: null,
      session_log: null,
    },
    working: {
      task: 'Test task',
      status: 'in_progress',
      branch: 'test-branch',
      next_action: 'Write tests',
    },
    decisions: [],
    files: { changed: [], read: [], hot: [] },
    gsd: null,
    open_questions: [],
    learnings: [],
    thread: { summary: '', key_exchanges: [] },
    ...overrides,
  };
}

// =============================================================================
// R03: formatAiderTrick guards for malformed fields
// =============================================================================

describe('formatAiderTrick guards (R03)', () => {
  it('handles files.changed = null without crash', () => {
    const cp = makeCheckpoint({
      files: { changed: null as any, read: [], hot: [] },
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    expect(md).not.toContain('You created');
  });

  it('handles files.changed with entries missing .path', () => {
    const cp = makeCheckpoint({
      files: {
        changed: [{ noPath: true } as any],
        read: [],
        hot: [],
      },
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    // Should not crash, should not render paths
    expect(md).not.toContain('You created');
  });

  it('handles decisions with what = null', () => {
    const cp = makeCheckpoint({
      decisions: [{ id: 'd1', what: null as any, why: 'reason', when: '2026-01-01', reversible: true }],
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    // Should not crash — the malformed decision should be skipped in Aider trick
    expect(md).toBeDefined();
    expect(md).not.toContain('You proposed null');
  });

  it('handles thread.key_exchanges with missing gist', () => {
    const cp = makeCheckpoint({
      decisions: [{ id: 'd1', what: 'Test', why: 'reason', when: '2026-01-01', reversible: true }],
      thread: {
        summary: 'test',
        key_exchanges: [{ role: 'user' } as any],
      },
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    // Should not crash — exchange with missing gist is skipped
    expect(md).toBeDefined();
    expect(md).not.toContain('undefined');
  });

  it('handles thread.key_exchanges = undefined', () => {
    const cp = makeCheckpoint({
      decisions: [{ id: 'd1', what: 'Test', why: 'reason', when: '2026-01-01', reversible: true }],
      thread: { summary: 'test', key_exchanges: undefined as any },
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    expect(md).toBeDefined();
    expect(md).toContain('You proposed Test');
  });

  it('handles valid checkpoint normally', () => {
    const cp = makeCheckpoint({
      decisions: [{ id: 'd1', what: 'Use tiered boost', why: 'Good design', when: '2026-01-01', reversible: true }],
      files: {
        changed: [{ path: 'src/main.ts', action: 'Write', summary: 'New module' }],
        read: [],
        hot: ['src/main.ts'],
      },
      thread: {
        summary: 'Working on boost',
        key_exchanges: [{ role: 'user', gist: 'Approved' }],
      },
    });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    expect(md).toContain('You proposed Use tiered boost');
    expect(md).toContain('You created src/main.ts');
    expect(md).toContain('I approved');
  });

  it('handles empty decisions array', () => {
    const cp = makeCheckpoint({ decisions: [] });
    const md = formatCheckpointForInjection(cp, { sections: [], resumeMode: true });
    expect(md).not.toContain('You proposed');
  });
});
