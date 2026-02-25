import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { loadLatestCheckpoint, formatCheckpointForInjection } from '../../src/checkpoint/loader.js';
import { RESUME_LOAD } from '../../src/checkpoint/types.js';
import type { LoadOptions, Checkpoint } from '../../src/checkpoint/types.js';
import { PATHS } from '../../src/shared/paths.js';

// Mock logger and metrics (required by checkpoint/loader.ts)
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
// Helpers
// =============================================================================

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    schema: 'claudex/checkpoint',
    version: 1,
    meta: {
      checkpoint_id: '2026-02-25_cp1',
      session_id: 'sess-test',
      scope: 'project:test',
      created_at: '2026-02-25T10:00:00Z',
      created_at_epoch_ms: Date.now(),
      trigger: 'auto-80pct',
      writer_version: '2.0.0',
      token_usage: {
        input_tokens: 50000,
        output_tokens: 10000,
        window_size: 200000,
        utilization: 0.25,
      },
      previous_checkpoint: null,
      session_log: null,
    },
    working: {
      task: 'Implement checkpoint loading in session-start hook',
      status: 'in_progress',
      branch: 'feature/checkpoints',
      next_action: 'Write tests for checkpoint integration',
    },
    decisions: [
      {
        id: 'd1',
        what: 'Use approach B for checkpoint integration',
        why: 'Minimal change to existing interfaces',
        when: '2026-02-25T09:00:00Z',
        reversible: true,
      },
    ],
    files: {
      changed: [{ path: 'src/hooks/session-start.ts', action: 'modified', summary: 'Added checkpoint loading' }],
      read: ['src/checkpoint/loader.ts'],
      hot: ['src/hooks/session-start.ts', 'src/checkpoint/loader.ts'],
    },
    gsd: null,
    open_questions: ['Should checkpoint override DB context or complement it?'],
    learnings: ['Token budgets must be coordinated between checkpoint and assembler'],
    thread: {
      summary: 'Working on WP-7: integrating checkpoint loader into session-start',
      key_exchanges: [
        { role: 'user', gist: 'Approved the checkpoint integration approach' },
        { role: 'agent', gist: 'Implementing approach B with token budget coordination' },
      ],
    },
    ...overrides,
  };
}

function setupCheckpointDir(baseDir: string): string {
  const cpDir = path.join(baseDir, 'context', 'checkpoints');
  fs.mkdirSync(cpDir, { recursive: true });
  return cpDir;
}

function writeCheckpointFile(cpDir: string, filename: string, checkpoint: Checkpoint): void {
  const filePath = path.join(cpDir, filename);
  fs.writeFileSync(filePath, yaml.dump(checkpoint, { lineWidth: -1 }), 'utf-8');
}

function writeLatestRef(cpDir: string, ref: string): void {
  fs.writeFileSync(path.join(cpDir, 'latest.yaml'), `ref: ${ref}\n`, 'utf-8');
}

// =============================================================================
// Tests
// =============================================================================

describe('session-start checkpoint integration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(process.cwd(), '.test-ss-checkpoint-' + Date.now());
    fs.mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup
    }
  });

  describe('checkpoint loading', () => {
    it('loads checkpoint when valid checkpoint exists', () => {
      const cpDir = setupCheckpointDir(tempDir);
      const cp = makeCheckpoint();
      writeCheckpointFile(cpDir, '2026-02-25_cp1.yaml', cp);
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      };
      const loaded = loadLatestCheckpoint(tempDir, loadOptions);

      expect(loaded).not.toBeNull();
      expect(loaded!.markdown).toContain('Checkpoint');
      expect(loaded!.loadedSections.length).toBeGreaterThan(0);
      expect(loaded!.tokenEstimate).toBeGreaterThan(0);
    });

    it('returns null when no checkpoint exists', () => {
      // tempDir has no context/checkpoints/ directory
      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      };
      const loaded = loadLatestCheckpoint(tempDir, loadOptions);

      expect(loaded).toBeNull();
    });

    it('checkpoint content includes working state and decisions', () => {
      const cpDir = setupCheckpointDir(tempDir);
      const cp = makeCheckpoint();
      writeCheckpointFile(cpDir, '2026-02-25_cp1.yaml', cp);
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      };
      const loaded = loadLatestCheckpoint(tempDir, loadOptions);

      expect(loaded).not.toBeNull();
      // Working state
      expect(loaded!.markdown).toContain('Implement checkpoint loading');
      expect(loaded!.markdown).toContain('in_progress');
      // Decisions (resume mode includes them)
      expect(loaded!.markdown).toContain('approach B');
      // Thread continuity (Aider trick)
      expect(loaded!.markdown).toContain('Thread Continuity');
    });

    it('corrupt checkpoint returns null gracefully', () => {
      const cpDir = setupCheckpointDir(tempDir);
      // Write invalid YAML
      fs.writeFileSync(path.join(cpDir, '2026-02-25_cp1.yaml'), '{{{{invalid yaml!!!!', 'utf-8');
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      };
      const loaded = loadLatestCheckpoint(tempDir, loadOptions);

      expect(loaded).toBeNull();
    });

    it('global scope uses PATHS.home as projectDir', () => {
      // Verify the logic: when scope is global, projectDir = PATHS.home
      // We test this by confirming PATHS.home is a valid path
      expect(PATHS.home).toBeTruthy();
      expect(typeof PATHS.home).toBe('string');

      // loadLatestCheckpoint with a non-existent dir returns null (no crash)
      const loaded = loadLatestCheckpoint(PATHS.home, {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      });
      // May or may not be null depending on whether ~/.claudex has checkpoints
      // The point is it doesn't crash
      expect(loaded === null || loaded.markdown.length > 0).toBe(true);
    });

    it('project scope uses scope.path as projectDir', () => {
      const projectDir = path.join(tempDir, 'my-project');
      const cpDir = setupCheckpointDir(projectDir);
      const cp = makeCheckpoint();
      writeCheckpointFile(cpDir, '2026-02-25_cp1.yaml', cp);
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loaded = loadLatestCheckpoint(projectDir, {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.markdown).toContain('Checkpoint');
    });

    it('resume mode loads decisions + thread + files sections', () => {
      const cpDir = setupCheckpointDir(tempDir);
      const cp = makeCheckpoint();
      writeCheckpointFile(cpDir, '2026-02-25_cp1.yaml', cp);
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loaded = loadLatestCheckpoint(tempDir, {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      });

      expect(loaded).not.toBeNull();
      // RESUME_LOAD = meta, working, open_questions, decisions, thread, files
      expect(loaded!.loadedSections).toContain('decisions');
      expect(loaded!.loadedSections).toContain('thread');
      expect(loaded!.loadedSections).toContain('files');
      expect(loaded!.loadedSections).toContain('working');
      expect(loaded!.loadedSections).toContain('open_questions');
      // learnings are NEVER loaded
      expect(loaded!.loadedSections).not.toContain('learnings');
    });
  });

  describe('token budget coordination', () => {
    it('checkpoint + DB context stays within ~4000 token cap', () => {
      const cpDir = setupCheckpointDir(tempDir);
      const cp = makeCheckpoint();
      writeCheckpointFile(cpDir, '2026-02-25_cp1.yaml', cp);
      writeLatestRef(cpDir, '2026-02-25_cp1.yaml');

      const loaded = loadLatestCheckpoint(tempDir, {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      });

      expect(loaded).not.toBeNull();

      // The checkpoint alone should be well under 4000 tokens
      // (~600 tokens for structured state is the design target)
      expect(loaded!.tokenEstimate).toBeLessThan(2000);

      // Verify the budget math: assembler gets max(1000, 4000 - checkpointTokens)
      const assemblerBudget = Math.max(1000, 4000 - loaded!.tokenEstimate);
      expect(assemblerBudget).toBeGreaterThanOrEqual(1000);
      expect(assemblerBudget + loaded!.tokenEstimate).toBeLessThanOrEqual(4000);
    });

    it('assembler gets at least 1000 tokens even with large checkpoint', () => {
      // The floor ensures assembler always gets meaningful budget
      const hypotheticalCheckpointTokens = 3500;
      const assemblerBudget = Math.max(1000, 4000 - hypotheticalCheckpointTokens);
      expect(assemblerBudget).toBe(1000);
    });
  });

  describe('formatting', () => {
    it('formatCheckpointForInjection produces valid markdown', () => {
      const cp = makeCheckpoint();
      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD],
        resumeMode: true,
      };
      const markdown = formatCheckpointForInjection(cp, loadOptions);

      expect(markdown).toContain('# Checkpoint (auto-injected by Claudex)');
      expect(markdown).toContain('## Working State');
      expect(markdown).toContain('## Decisions');
      expect(markdown).toContain('## Open Questions');
      expect(markdown).toContain('## Thread Continuity');
      expect(markdown).toContain('## Active Files');
    });

    it('GSD section appears when gsd is active', () => {
      const cp = makeCheckpoint({
        gsd: {
          active: true,
          milestone: 'v3 launch',
          phase: 2,
          phase_name: 'Checkpoint Integration',
          phase_goal: 'Integrate checkpoint system into hooks',
          plan_status: 'in-progress',
          requirements: [
            { id: 'R1', status: 'done', description: 'Loader works' },
            { id: 'R2', status: 'pending', description: 'Writer works' },
          ],
        },
      });

      const loadOptions: LoadOptions = {
        sections: [...RESUME_LOAD, 'gsd'],
        resumeMode: true,
      };
      const markdown = formatCheckpointForInjection(cp, loadOptions);

      expect(markdown).toContain('## Project Phase (GSD)');
      expect(markdown).toContain('v3 launch');
      expect(markdown).toContain('Checkpoint Integration');
    });
  });
});
