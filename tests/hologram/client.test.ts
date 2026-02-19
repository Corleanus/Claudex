/**
 * Claudex v2 — Hologram Client Phase 10 Tests
 *
 * Tests for:
 *   - projectDir + projectConfig + boostFiles in sidecar request payload (Test #16)
 *   - queryWithFallback threads projectDir + boostFiles (degradation)
 *   - Post-compact bridge: active_files boost (Tests #27-28)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { HologramClient, classifyTemperature } from '../../src/hologram/client.js';
import { ResilientHologramClient } from '../../src/hologram/degradation.js';
import type { ClaudexConfig, HologramResponse, SidecarRequest } from '../../src/shared/types.js';
import { HologramUnavailableError } from '../../src/shared/errors.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { migration_5 } from '../../src/db/schema-phase3.js';
import { migration_6 } from '../../src/db/schema-phase10.js';

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

// =============================================================================
// Helpers
// =============================================================================

function setupDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id INTEGER PRIMARY KEY,
      version INTEGER UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const runner = new MigrationRunner(db);
  migration_1(runner);
  migration_2(runner);
  migration_3(runner);
  migration_4(runner);
  migration_5(runner);
  migration_6(runner);
  return db;
}

const config: ClaudexConfig = {
  hologram: {
    enabled: true,
    timeout_ms: 1000,
    health_interval_ms: 30000,
    project_patterns: ['**/*.md', '**/*.ts'],
    project_exclude: ['node_modules/**', '.git/**'],
    project_max_files: 100,
  },
};

const successResponse: HologramResponse = {
  hot: [{ path: 'src/main.ts', raw_pressure: 0.9, temperature: 'HOT', system_bucket: 0, pressure_bucket: 43 }],
  warm: [{ path: 'src/utils.ts', raw_pressure: 0.5, temperature: 'WARM', system_bucket: 0, pressure_bucket: 24 }],
  cold: [],
};

function makeMockLauncher() {
  return {
    getPort: vi.fn().mockReturnValue(12345),
    isRunning: vi.fn().mockReturnValue(true),
    start: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockProtocol() {
  return {
    send: vi.fn().mockResolvedValue({
      id: 'test-id',
      type: 'result',
      payload: {
        hot: successResponse.hot,
        warm: successResponse.warm,
        cold: successResponse.cold,
      },
    }),
  };
}

function makeMockClient() {
  return {
    query: vi.fn(),
    notifyFileChanges: vi.fn(),
    ping: vi.fn(),
    isAvailable: vi.fn(),
    persistScores: vi.fn(),
    requestRescore: vi.fn(),
  } as unknown as HologramClient & { query: ReturnType<typeof vi.fn> };
}

// =============================================================================
// Tests
// =============================================================================

describe('HologramClient.query — projectDir + projectConfig (Test #16)', () => {
  it('includes project_dir and project_config in sidecar request when projectDir is provided', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    await client.query('test prompt', 1, 'sess-1', '/path/to/project');

    expect(protocol.send).toHaveBeenCalledTimes(1);
    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    expect(payload.project_dir).toBe('/path/to/project');
    expect(payload.project_config).toBeDefined();
    expect(payload.project_config.patterns).toEqual(['**/*.md', '**/*.ts']);
    expect(payload.project_config.exclude).toEqual(['node_modules/**', '.git/**']);
    expect(payload.project_config.max_files).toBe(100);
  });

  it('does not include project_dir or project_config when projectDir is undefined', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    await client.query('test prompt', 1, 'sess-1');

    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    expect(payload.project_dir).toBeUndefined();
    expect(payload.project_config).toBeUndefined();
  });

  it('includes boost_files in sidecar request when provided', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    const boostFiles = ['src/hooks/pre-compact.ts', 'src/db/checkpoint.ts'];
    await client.query('test prompt', 1, 'sess-1', '/path/to/project', boostFiles);

    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    expect(payload.boost_files).toEqual(boostFiles);
  });

  it('does not include boost_files when empty array', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    await client.query('test prompt', 1, 'sess-1', undefined, []);

    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    expect(payload.boost_files).toBeUndefined();
  });

  it('always includes claude_dir in payload', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    await client.query('test prompt', 1, 'sess-1');

    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    expect(payload.claude_dir).toBeDefined();
    expect(typeof payload.claude_dir).toBe('string');
    expect(payload.claude_dir).toContain('.claude');
  });

  it('uses config defaults for project_config when config fields are missing', async () => {
    const minimalConfig: ClaudexConfig = {
      hologram: {
        enabled: true,
        timeout_ms: 1000,
        health_interval_ms: 30000,
        // No project_patterns, project_exclude, project_max_files
      },
    };
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, minimalConfig);

    await client.query('test prompt', 1, 'sess-1', '/path/to/project');

    const [, request] = protocol.send.mock.calls[0]!;
    const payload = request.payload;

    // Should fall back to hardcoded defaults
    expect(payload.project_config.patterns).toEqual(['*.md', '*.ts', '*.py', '**/*.md', '**/*.ts', '**/*.py']);
    expect(payload.project_config.exclude).toContain('node_modules/**');
    expect(payload.project_config.exclude).toContain('**/*.test.ts');
    expect(payload.project_config.max_files).toBe(200);
  });
});

describe('ResilientHologramClient — projectDir + boostFiles threading', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  it('threads projectDir to client.query', async () => {
    const mockClient = makeMockClient();
    mockClient.query.mockResolvedValueOnce(successResponse);

    const resilient = new ResilientHologramClient(mockClient, config);
    await resilient.queryWithFallback(
      'prompt', 1, 'sess-1', [], db, 'myproject', '/path/to/project',
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      'prompt', 1, 'sess-1', '/path/to/project', undefined,
    );
  });

  it('threads boostFiles to client.query', async () => {
    const mockClient = makeMockClient();
    mockClient.query.mockResolvedValueOnce(successResponse);

    const boostFiles = ['src/a.ts', 'src/b.ts'];
    const resilient = new ResilientHologramClient(mockClient, config);
    await resilient.queryWithFallback(
      'prompt', 1, 'sess-1', [], db, 'myproject', '/path', boostFiles,
    );

    expect(mockClient.query).toHaveBeenCalledWith(
      'prompt', 1, 'sess-1', '/path', boostFiles,
    );
  });

  it('threads projectDir through on retry', async () => {
    const mockClient = makeMockClient();
    mockClient.query
      .mockRejectedValueOnce(new HologramUnavailableError('first fail'))
      .mockResolvedValueOnce(successResponse);

    const resilient = new ResilientHologramClient(mockClient, config);
    await resilient.queryWithFallback(
      'prompt', 1, 'sess-1', [], db, 'proj', '/proj/path',
    );

    // Both calls should have projectDir
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(mockClient.query.mock.calls[0]![3]).toBe('/proj/path');
    expect(mockClient.query.mock.calls[1]![3]).toBe('/proj/path');
  });
});

describe('Post-Compact Bridge — Active Files Boost (Tests #27-28)', () => {
  it('Test #27: boost_files are passed when present', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    const boostFiles = ['src/hooks/pre-compact.ts', 'src/db/checkpoint.ts'];
    await client.query('post-compact prompt', 1, 'sess-1', '/proj', boostFiles);

    const [, request] = protocol.send.mock.calls[0]!;
    expect(request.payload.boost_files).toEqual(boostFiles);
  });

  it('Test #28: boost_files are not sent when undefined (natural decay)', async () => {
    const launcher = makeMockLauncher();
    const protocol = makeMockProtocol();
    const client = new HologramClient(launcher as any, protocol as any, config);

    // After 3 turns, boostFiles should stop being sent
    await client.query('normal prompt', 4, 'sess-1', '/proj');

    const [, request] = protocol.send.mock.calls[0]!;
    expect(request.payload.boost_files).toBeUndefined();
  });
});

describe('classifyTemperature', () => {
  it('classifies HOT correctly', () => {
    expect(classifyTemperature(40)).toBe('HOT');
    expect(classifyTemperature(47)).toBe('HOT');
  });

  it('classifies WARM correctly', () => {
    expect(classifyTemperature(20)).toBe('WARM');
    expect(classifyTemperature(39)).toBe('WARM');
  });

  it('classifies COLD correctly', () => {
    expect(classifyTemperature(0)).toBe('COLD');
    expect(classifyTemperature(19)).toBe('COLD');
  });
});
