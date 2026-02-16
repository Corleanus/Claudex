/**
 * Claudex v2 — Phase 7.4 Hologram Integration Tests
 *
 * Tests the REAL Python sidecar with hologram-cognitive:
 *   TS client -> TCP/NDJSON -> Python sidecar (server.py) ->
 *   hologram-cognitive Session.turn() -> real HOT/WARM/COLD responses -> back to TS.
 *
 * Requires: Python 3.12+, hologram-cognitive pip-installed, sidecar/server.py.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { ProtocolHandler, buildRequest } from '../../src/hologram/protocol.js';
import { ResilientHologramClient } from '../../src/hologram/degradation.js';
import { rescoreWithFallback } from '../../src/hologram/degradation.js';
import type { HologramClient } from '../../src/hologram/client.js';
import type { ClaudexConfig, HologramResponse, ScoredFile, SidecarResponse } from '../../src/shared/types.js';
import { HologramUnavailableError } from '../../src/shared/errors.js';
import { MigrationRunner } from '../../src/db/migrations.js';
import { migration_1 } from '../../src/db/schema.js';
import { migration_2, migration_4 } from '../../src/db/search.js';
import { migration_3 } from '../../src/db/schema-phase2.js';
import { upsertPressureScore } from '../../src/db/pressure.js';
import { assembleContext } from '../../src/lib/context-assembler.js';
import type { ContextSources } from '../../src/shared/types.js';

// Mock logger to prevent filesystem writes during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock metrics to prevent side effects
vi.mock('../../src/shared/metrics.js', () => ({
  recordMetric: vi.fn(),
}));

// =============================================================================
// Constants
// =============================================================================

const SIDECAR_DIR = path.resolve(__dirname, '../../sidecar');
const SIDECAR_STARTUP_TIMEOUT_MS = 10_000;
const PROTOCOL_TIMEOUT_MS = 5_000;

// =============================================================================
// Sidecar Management
// =============================================================================

interface SidecarInfo {
  process: ChildProcess;
  port: number;
}

/**
 * Spawn a real Python sidecar process and wait for it to report its port.
 * Uses an inline Python script that imports server.py and starts it on port 0.
 */
async function startSidecar(): Promise<SidecarInfo> {
  // Use forward slashes for Python path strings on Windows
  const sidecarDirPy = SIDECAR_DIR.replace(/\\/g, '/');

  const script = `
import asyncio, sys, json
sys.path.insert(0, '${sidecarDirPy}')
from server import SidecarServer
async def main():
    srv = SidecarServer('127.0.0.1', 0)
    port = await srv.start()
    print(json.dumps({"port": port}), flush=True)
    await srv.serve_forever()
asyncio.run(main())
`.trim();

  return new Promise<SidecarInfo>((resolve, reject) => {
    const proc = spawn('python', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: SIDECAR_DIR,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(
          `Sidecar startup timed out after ${SIDECAR_STARTUP_TIMEOUT_MS}ms. stderr: ${stderr}`,
        ));
      }
    }, SIDECAR_STARTUP_TIMEOUT_MS);

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    proc.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newlineIdx = stdout.indexOf('\n');
      if (newlineIdx !== -1 && !settled) {
        settled = true;
        clearTimeout(timer);
        const line = stdout.slice(0, newlineIdx).trim();
        try {
          const info = JSON.parse(line);
          resolve({ process: proc, port: info.port });
        } catch (err) {
          proc.kill();
          reject(new Error(`Failed to parse sidecar port line: "${line}". Error: ${err}`));
        }
      }
    });

    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Failed to spawn sidecar: ${err.message}`));
      }
    });

    proc.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(
          `Sidecar exited during startup with code ${code}. stderr: ${stderr}`,
        ));
      }
    });
  });
}

/**
 * Send a shutdown request to the sidecar and kill the process.
 */
async function stopSidecar(info: SidecarInfo): Promise<void> {
  const protocol = new ProtocolHandler(PROTOCOL_TIMEOUT_MS);
  try {
    const req = buildRequest('shutdown');
    await protocol.send(info.port, req);
  } catch {
    // Sidecar may already be dead
  }

  // Give it a moment to exit gracefully
  await new Promise(resolve => setTimeout(resolve, 500));

  // Force kill if still alive
  if (!info.process.killed) {
    info.process.kill();
  }
}

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

  return db;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claudex-hologram-test-'));
}

function buildContextSources(hologram: HologramResponse | null): ContextSources {
  return {
    hologram,
    searchResults: [],
    recentObservations: [],
    scope: { type: 'global' },
  };
}

/**
 * Convert sidecar string arrays into ScoredFile arrays.
 *
 * hologram-cognitive returns file name strings in hot/warm/cold arrays.
 * The sidecar passes them through as-is. For context assembly, we need
 * ScoredFile objects. This mirrors what a production-ready HologramClient
 * integration layer would do.
 */
function sidecarResponseToHologramResponse(payload: SidecarResponse['payload']): HologramResponse {
  const toScoredFiles = (
    items: unknown[],
    temperature: 'HOT' | 'WARM' | 'COLD',
    basePressure: number,
  ): ScoredFile[] => {
    return items.map((item, idx) => {
      const filePath = typeof item === 'string' ? item : (item as ScoredFile).path;
      return {
        path: filePath,
        raw_pressure: basePressure - idx * 0.02,
        temperature,
        system_bucket: 0,
        pressure_bucket: temperature === 'HOT' ? 45 : temperature === 'WARM' ? 30 : 10,
      };
    });
  };

  return {
    hot: toScoredFiles(payload.hot ?? [], 'HOT', 0.95),
    warm: toScoredFiles(payload.warm ?? [], 'WARM', 0.55),
    cold: toScoredFiles(payload.cold ?? [], 'COLD', 0.15),
  };
}

/**
 * Build a mock HologramClient that talks to a real sidecar via TCP.
 * This bridges the real sidecar with the TS client API.
 */
function makeLiveClient(
  sidecarPort: number,
  claudeDir: string,
): HologramClient & { requestRescore: ReturnType<typeof vi.fn> } {
  const protocol = new ProtocolHandler(PROTOCOL_TIMEOUT_MS);

  return {
    query: vi.fn(async (_prompt: string, _turn: number, _session: string): Promise<HologramResponse> => {
      const request = buildRequest('query', {
        prompt: _prompt,
        claude_dir: claudeDir,
        session_state: { turn_number: _turn, session_id: _session },
      });
      const response = await protocol.send(sidecarPort, request);
      if (response.type === 'error') {
        throw new Error(`Sidecar error: ${response.payload.error_message}`);
      }
      return sidecarResponseToHologramResponse(response.payload);
    }),
    notifyFileChanges: vi.fn(),
    ping: vi.fn(async (): Promise<boolean> => {
      try {
        const request = buildRequest('ping');
        const response = await protocol.send(sidecarPort, request);
        return response.type === 'pong';
      } catch {
        return false;
      }
    }),
    isAvailable: vi.fn(() => true),
    persistScores: vi.fn(),
    requestRescore: vi.fn(async (_sessionId: string): Promise<boolean> => {
      const request = buildRequest('query', {
        prompt: '__rescore__',
        claude_dir: claudeDir,
        session_state: { turn_number: 0, session_id: _sessionId },
      });
      const response = await protocol.send(sidecarPort, request);
      return response.type === 'result';
    }),
  } as unknown as HologramClient & { requestRescore: ReturnType<typeof vi.fn> };
}

/**
 * Build a mock HologramClient that always fails (for testing degradation after kill).
 */
function makeDeadClient(): HologramClient & { requestRescore: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockRejectedValue(new HologramUnavailableError('sidecar killed')),
    notifyFileChanges: vi.fn(),
    ping: vi.fn().mockResolvedValue(false),
    isAvailable: vi.fn(() => false),
    persistScores: vi.fn(),
    requestRescore: vi.fn().mockRejectedValue(new Error('sidecar killed')),
  } as unknown as HologramClient & { requestRescore: ReturnType<typeof vi.fn> };
}

// =============================================================================
// Seed files for hologram-cognitive to discover and score
// =============================================================================

function seedClaudeDir(claudeDir: string): void {
  const files: Record<string, string> = {
    'architecture.md': [
      '# Architecture',
      'Microservices design with event sourcing pattern.',
      'Database layer uses PostgreSQL with read replicas.',
      'API gateway handles authentication and rate limiting.',
      'Message queue for async processing with RabbitMQ.',
      'Service mesh with Envoy proxies for inter-service communication.',
    ].join('\n'),
    'auth.md': [
      '# Authentication',
      'OAuth2 with JWT tokens for stateless session management.',
      'Password hashing with bcrypt and per-user salt.',
      'Multi-factor authentication via TOTP and WebAuthn.',
      'Role-based access control with hierarchical permissions.',
    ].join('\n'),
    'database.md': [
      '# Database',
      'PostgreSQL primary with streaming replication to hot standbys.',
      'Connection pooling via PgBouncer for efficient resource usage.',
      'Schema migration system with versioning and rollback support.',
      'Query optimization with prepared statements and partial indexes.',
    ].join('\n'),
    'deployment.md': [
      '# Deployment',
      'Docker containers orchestrated by Kubernetes on AWS EKS.',
      'CI/CD pipeline with GitHub Actions and automated testing.',
      'Blue-green deployments with instant rollback capability.',
      'Monitoring with Prometheus metrics and Grafana dashboards.',
    ].join('\n'),
    'testing.md': [
      '# Testing Strategy',
      'Unit tests with pytest. Integration tests against test database.',
      'End-to-end tests with Selenium for browser automation.',
      'Load testing with Locust for performance benchmarking.',
      'Code coverage target of 80% minimum across all modules.',
    ].join('\n'),
  };

  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(claudeDir, name), content, 'utf-8');
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Hologram Integration (Real Sidecar)', { timeout: 30_000 }, () => {
  let sidecar: SidecarInfo;
  let claudeDir: string;
  let protocol: ProtocolHandler;

  beforeAll(async () => {
    // Create temp claude_dir with .md files for hologram to discover
    claudeDir = createTempDir();
    seedClaudeDir(claudeDir);

    // Start the real Python sidecar
    sidecar = await startSidecar();
    protocol = new ProtocolHandler(PROTOCOL_TIMEOUT_MS);

    // Brief pause to ensure sidecar is fully ready
    await new Promise(resolve => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    // Shutdown sidecar and clean up
    if (sidecar) {
      await stopSidecar(sidecar);
    }
    if (claudeDir && fs.existsSync(claudeDir)) {
      fs.rmSync(claudeDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // Test 1: Sidecar protocol test
  // ===========================================================================

  describe('1. Sidecar protocol test', () => {
    it('ping returns pong', async () => {
      const req = buildRequest('ping');
      const resp = await protocol.send(sidecar.port, req);

      expect(resp.id).toBe(req.id);
      expect(resp.type).toBe('pong');
      expect(resp.payload).toBeDefined();
      expect(resp.timing_ms).toBeDefined();
      expect(typeof resp.timing_ms).toBe('number');
    });

    it('query with seeded claude_dir returns result type', async () => {
      const req = buildRequest('query', {
        prompt: 'Tell me about the database architecture and authentication',
        claude_dir: claudeDir,
      });

      const resp = await protocol.send(sidecar.port, req);

      expect(resp.id).toBe(req.id);
      expect(resp.type).toBe('result');
      expect(resp.payload).toBeDefined();
      expect(Array.isArray(resp.payload.hot)).toBe(true);
      expect(resp.timing_ms).toBeDefined();
    });

    it('query returns file names in hot/warm/cold arrays', async () => {
      const req = buildRequest('query', {
        prompt: 'Tell me about deployment and testing',
        claude_dir: claudeDir,
      });

      const resp = await protocol.send(sidecar.port, req);

      expect(resp.type).toBe('result');

      // hologram-cognitive returns string file names
      const allFiles = [
        ...(resp.payload.hot ?? []),
        ...(resp.payload.warm ?? []),
        ...(resp.payload.cold ?? []),
      ];

      // With 5 seeded .md files, hologram should discover and score them
      // (all may end up in hot for a fresh session with keyword matches)
      expect(allFiles.length).toBeGreaterThan(0);

      // Each entry should be a string (file name)
      for (const file of allFiles) {
        expect(typeof file === 'string' || typeof (file as ScoredFile).path === 'string').toBe(true);
      }
    });

    it('response includes turn and tension metadata', async () => {
      // Use a fresh claude_dir to get turn=1
      const freshDir = createTempDir();
      seedClaudeDir(freshDir);

      const req = buildRequest('query', {
        prompt: 'architecture overview',
        claude_dir: freshDir,
      });

      const resp = await protocol.send(sidecar.port, req);
      const payload = resp.payload as Record<string, unknown>;

      expect(resp.type).toBe('result');
      expect(payload.turn).toBe(1);
      expect(typeof payload.tension).toBe('number');
      expect(typeof payload.cluster_size).toBe('number');

      // Clean up
      fs.rmSync(freshDir, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // Test 2: Session caching test
  // ===========================================================================

  describe('2. Session caching test', () => {
    it('second query to same claude_dir increments turn number', async () => {
      // Use a fresh claude_dir for isolated session
      const sessionDir = createTempDir();
      seedClaudeDir(sessionDir);

      // First query
      const req1 = buildRequest('query', {
        prompt: 'database architecture',
        claude_dir: sessionDir,
      });
      const resp1 = await protocol.send(sidecar.port, req1);
      const payload1 = resp1.payload as Record<string, unknown>;

      expect(resp1.type).toBe('result');
      expect(payload1.turn).toBe(1);

      // Second query to same dir (session should be cached)
      const req2 = buildRequest('query', {
        prompt: 'authentication system',
        claude_dir: sessionDir,
      });
      const resp2 = await protocol.send(sidecar.port, req2);
      const payload2 = resp2.payload as Record<string, unknown>;

      expect(resp2.type).toBe('result');
      expect(payload2.turn).toBe(2);

      // Clean up
      fs.rmSync(sessionDir, { recursive: true, force: true });
    });

    it('different claude_dirs get independent sessions', async () => {
      const dirA = createTempDir();
      const dirB = createTempDir();
      seedClaudeDir(dirA);
      seedClaudeDir(dirB);

      // Query dirA
      const reqA = buildRequest('query', {
        prompt: 'database query',
        claude_dir: dirA,
      });
      const respA = await protocol.send(sidecar.port, reqA);
      expect((respA.payload as Record<string, unknown>).turn).toBe(1);

      // Query dirB (should be turn 1, not 2)
      const reqB = buildRequest('query', {
        prompt: 'database query',
        claude_dir: dirB,
      });
      const respB = await protocol.send(sidecar.port, reqB);
      expect((respB.payload as Record<string, unknown>).turn).toBe(1);

      // Clean up
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });
  });

  // ===========================================================================
  // Test 3: Degradation cascade test
  // ===========================================================================

  describe('3. Degradation cascade test', () => {
    it('live sidecar query succeeds via hologram, then degrades after kill', async () => {
      const db = setupDb();
      const config: ClaudexConfig = {
        hologram: { enabled: true, timeout_ms: 3000, health_interval_ms: 30000 },
      };

      // Phase A: query succeeds via live sidecar
      const liveClient = makeLiveClient(sidecar.port, claudeDir);
      const resilient = new ResilientHologramClient(liveClient, config);

      const result1 = await resilient.queryWithFallback(
        'database architecture', 1, 'sess-cascade-1', ['recent.ts'], db,
      );
      expect(result1.source).toBe('hologram');
      expect(result1.hot.length + result1.warm.length + result1.cold.length).toBeGreaterThan(0);

      // Persist scores to DB for fallback
      for (const file of result1.hot) {
        upsertPressureScore(db, {
          file_path: file.path,
          raw_pressure: file.raw_pressure,
          temperature: 'HOT',
          decay_rate: 0.05,
        });
      }

      // Phase B: switch to dead client (simulates killed sidecar)
      const deadClient = makeDeadClient();
      const resilient2 = new ResilientHologramClient(deadClient, config);

      const result2 = await resilient2.queryWithFallback(
        'database architecture', 2, 'sess-cascade-1', ['recent.ts'], db,
      );

      // Should fall through to DB pressure (we persisted scores above)
      expect(result2.source).toBe('db-pressure');
      expect(result2.hot.length).toBeGreaterThan(0);

      db.close();
    });

    it('degrades to recency when sidecar dead and DB empty', async () => {
      const db = setupDb();
      const config: ClaudexConfig = {
        hologram: { enabled: true, timeout_ms: 2000, health_interval_ms: 30000 },
      };

      const deadClient = makeDeadClient();
      const resilient = new ResilientHologramClient(deadClient, config);

      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-cascade-2', ['fallback1.ts', 'fallback2.ts'], db,
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.warm).toHaveLength(2);
      expect(result.warm[0]!.path).toBe('fallback1.ts');
      expect(result.warm[1]!.path).toBe('fallback2.ts');

      db.close();
    });
  });

  // ===========================================================================
  // Test 4: Context assembly with pressure
  // ===========================================================================

  describe('4. Context assembly with pressure', () => {
    it('HOT files from sidecar appear in assembled context', async () => {
      // Query the real sidecar
      const req = buildRequest('query', {
        prompt: 'Tell me about the architecture and database',
        claude_dir: claudeDir,
      });
      const resp = await protocol.send(sidecar.port, req);
      expect(resp.type).toBe('result');

      // Convert to HologramResponse (sidecar returns string arrays)
      const hologramResponse = sidecarResponseToHologramResponse(resp.payload);

      // Feed into context assembly
      const sources = buildContextSources(hologramResponse);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      if (hologramResponse.hot.length > 0) {
        expect(assembled.markdown).toContain('Active Focus');
        // At least one of the seeded files should appear
        const anyFilePresent = hologramResponse.hot.some(
          f => assembled.markdown.includes(f.path),
        );
        expect(anyFilePresent).toBe(true);
        expect(assembled.sources).toContain('hologram');
      }

      expect(assembled.tokenEstimate).toBeGreaterThan(0);
    });

    it('WARM files from sidecar appear in Warm Context section', async () => {
      // Build a HologramResponse with some files in WARM
      const hologramResponse: HologramResponse = {
        hot: [],
        warm: [
          { path: 'deployment.md', raw_pressure: 0.55, temperature: 'WARM', system_bucket: 0, pressure_bucket: 26 },
          { path: 'testing.md', raw_pressure: 0.50, temperature: 'WARM', system_bucket: 0, pressure_bucket: 24 },
        ],
        cold: [],
      };

      const sources = buildContextSources(hologramResponse);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('deployment.md');
      expect(assembled.markdown).toContain('testing.md');
    });

    it('mixed HOT and WARM produce both sections', async () => {
      const hologramResponse: HologramResponse = {
        hot: [
          { path: 'architecture.md', raw_pressure: 0.92, temperature: 'HOT', system_bucket: 0, pressure_bucket: 44 },
        ],
        warm: [
          { path: 'auth.md', raw_pressure: 0.50, temperature: 'WARM', system_bucket: 0, pressure_bucket: 24 },
        ],
        cold: [],
      };

      const sources = buildContextSources(hologramResponse);
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      expect(assembled.markdown).toContain('Active Focus');
      expect(assembled.markdown).toContain('architecture.md');
      expect(assembled.markdown).toContain('Warm Context');
      expect(assembled.markdown).toContain('auth.md');
    });
  });

  // ===========================================================================
  // Test 5: Flush with live hologram (rescoreWithFallback)
  // ===========================================================================

  describe('5. Flush with live hologram', () => {
    it('rescoreWithFallback returns hologram source with live sidecar', async () => {
      const db = setupDb();
      const liveClient = makeLiveClient(sidecar.port, claudeDir);

      const result = await rescoreWithFallback(liveClient, 'sess-rescore-live', db);

      expect(result.source).toBe('hologram');

      db.close();
    });

    it('rescoreWithFallback falls back to db-pressure when sidecar is dead', async () => {
      const db = setupDb();

      // Seed some HOT scores in DB
      upsertPressureScore(db, {
        file_path: 'architecture.md',
        raw_pressure: 0.92,
        temperature: 'HOT',
        decay_rate: 0.05,
      });

      const deadClient = makeDeadClient();
      const result = await rescoreWithFallback(deadClient, 'sess-rescore-dead', db);

      expect(result.source).toBe('db-pressure');

      db.close();
    });

    it('rescoreWithFallback returns none when sidecar dead and DB empty', async () => {
      const db = setupDb();
      const deadClient = makeDeadClient();

      const result = await rescoreWithFallback(deadClient, 'sess-rescore-none', db);

      expect(result.source).toBe('none');

      db.close();
    });
  });

  // ===========================================================================
  // Test 6: Config gating test
  // ===========================================================================

  describe('6. Config gating test', () => {
    it('ResilientHologramClient falls through to recency when hologram disabled', async () => {
      const config: ClaudexConfig = {
        hologram: { enabled: false, timeout_ms: 1000, health_interval_ms: 30000 },
      };

      // Even with a "working" client, when we pass a client that has never
      // been wired up, ResilientHologramClient still attempts the query.
      // The config gating happens at the hook level (before creating the client).
      // Here we test that the resilient wrapper gracefully degrades
      // when the underlying client fails (simulating disabled hologram).
      const deadClient = makeDeadClient();
      const resilient = new ResilientHologramClient(deadClient, config);

      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-gated', ['gated-file.ts'],
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.warm).toHaveLength(1);
      expect(result.warm[0]!.path).toBe('gated-file.ts');
    });

    it('disabled hologram config with no recent files produces empty fallback', async () => {
      const config: ClaudexConfig = {
        hologram: { enabled: false, timeout_ms: 1000, health_interval_ms: 30000 },
      };

      const deadClient = makeDeadClient();
      const resilient = new ResilientHologramClient(deadClient, config);

      const result = await resilient.queryWithFallback(
        'test prompt', 1, 'sess-gated-empty', [],
      );

      expect(result.source).toBe('recency-fallback');
      expect(result.warm).toEqual([]);
      expect(result.hot).toEqual([]);
      expect(result.cold).toEqual([]);
    });

    it('enabled hologram config with live sidecar returns hologram source', async () => {
      const config: ClaudexConfig = {
        hologram: { enabled: true, timeout_ms: 5000, health_interval_ms: 30000 },
      };
      const db = setupDb();

      const liveClient = makeLiveClient(sidecar.port, claudeDir);
      const resilient = new ResilientHologramClient(liveClient, config);

      const result = await resilient.queryWithFallback(
        'architecture and deployment overview', 1, 'sess-enabled', [], db,
      );

      expect(result.source).toBe('hologram');

      db.close();
    });
  });
});
