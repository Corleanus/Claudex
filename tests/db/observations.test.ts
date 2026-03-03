import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { MigrationRunner } from '../../src/db/migrations.js';
import {
  storeObservation,
  getObservationsBySession,
  getRecentObservations,
  getObservationsSince,
  deleteOldObservations,
} from '../../src/db/observations.js';
import type { Observation } from '../../src/shared/types.js';

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
  runner.run();
  return db;
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'test-session-001',
    project: 'test-project',
    timestamp: '2024-01-01T00:00:00.000Z',
    timestamp_epoch: 1704067200000,
    tool_name: 'Read',
    category: 'file',
    title: 'Read file',
    content: 'File content',
    importance: 5,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

let db: Database.Database;

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
});

describe('storeObservation', () => {
  it('stores a new observation', () => {
    const obs = makeObservation();
    const result = storeObservation(db, obs);

    expect(result.id).toBeGreaterThan(0);

    const rows = getObservationsBySession(db, obs.session_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Read file');
  });

  it('converts seconds to milliseconds for timestamp_epoch', () => {
    // Epoch for 2021-01-01 in seconds
    const secondsEpoch = 1609459200;
    const obs = makeObservation({ timestamp_epoch: secondsEpoch });

    storeObservation(db, obs);

    const rows = getObservationsBySession(db, obs.session_id);
    // Should be stored as milliseconds
    expect(rows[0]!.timestamp_epoch).toBe(1609459200000);
  });

  it('keeps milliseconds unchanged for timestamp_epoch', () => {
    const msEpoch = 1609459200000;
    const obs = makeObservation({ timestamp_epoch: msEpoch });

    storeObservation(db, obs);

    const rows = getObservationsBySession(db, obs.session_id);
    expect(rows[0]!.timestamp_epoch).toBe(msEpoch);
  });
});

describe('getObservationsBySession', () => {
  it('returns observations ordered by timestamp_epoch ASC', () => {
    storeObservation(db, makeObservation({ title: 'Second', timestamp_epoch: 1704067200000 }));
    storeObservation(db, makeObservation({ title: 'First', timestamp_epoch: 1704067100000 }));
    storeObservation(db, makeObservation({ title: 'Third', timestamp_epoch: 1704067300000 }));

    const rows = getObservationsBySession(db, 'test-session-001');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.title).toBe('First');
    expect(rows[1]!.title).toBe('Second');
    expect(rows[2]!.title).toBe('Third');
  });

  it('returns empty array for non-existent session', () => {
    const rows = getObservationsBySession(db, 'non-existent');
    expect(rows).toEqual([]);
  });
});

describe('deleteOldObservations', () => {
  it('deletes observations older than threshold', () => {
    storeObservation(db, makeObservation({ title: 'Old', timestamp_epoch: 1704067000000 }));
    storeObservation(db, makeObservation({ title: 'New', timestamp_epoch: 1704067300000 }));

    const deleted = deleteOldObservations(db, 1704067200000);
    expect(deleted).toBe(1);

    const rows = getObservationsBySession(db, 'test-session-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('New');
  });

  it('converts seconds to milliseconds for threshold', () => {
    // Store observations with ms timestamps
    storeObservation(db, makeObservation({ title: 'Old', timestamp_epoch: 1609459100000 }));
    storeObservation(db, makeObservation({ title: 'New', timestamp_epoch: 1609459300000 }));

    // Pass threshold in seconds (should be converted to ms)
    const thresholdSeconds = 1609459200;
    const deleted = deleteOldObservations(db, thresholdSeconds);

    expect(deleted).toBe(1);

    const rows = getObservationsBySession(db, 'test-session-001');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('New');
  });

  it('returns 0 when no observations match', () => {
    storeObservation(db, makeObservation({ timestamp_epoch: 1704067300000 }));

    const deleted = deleteOldObservations(db, 1704067000000);
    expect(deleted).toBe(0);
  });
});

describe('global scope isolation', () => {
  it('getRecentObservations with project=undefined returns only global rows', () => {
    // Global observation (project=undefined → stored as NULL)
    storeObservation(db, makeObservation({
      title: 'Global observation',
      project: undefined,
      timestamp_epoch: 1704067200000,
    }));
    // Project-scoped observation
    storeObservation(db, makeObservation({
      title: 'Project observation',
      project: 'my-proj',
      timestamp_epoch: 1704067300000,
    }));

    const rows = getRecentObservations(db, 10); // no project = undefined
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Global observation');
    expect(rows[0]!.project).toBeUndefined();
  });

  it('getObservationsSince with project=undefined returns only global rows', () => {
    // Global observation
    storeObservation(db, makeObservation({
      title: 'Global since',
      project: undefined,
      timestamp_epoch: 1704067200000,
    }));
    // Project-scoped observation
    storeObservation(db, makeObservation({
      title: 'Project since',
      project: 'my-proj',
      timestamp_epoch: 1704067300000,
    }));

    const rows = getObservationsSince(db, 1704067000000); // no project = undefined
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Global since');
    expect(rows[0]!.project).toBeUndefined();
  });

  it('cross-project isolation: inserting project-A and project-B, querying each, no cross-contamination', () => {
    storeObservation(db, makeObservation({ title: 'Alpha', project: 'alpha', timestamp_epoch: 1704067200000 }));
    storeObservation(db, makeObservation({ title: 'Beta', project: 'beta', timestamp_epoch: 1704067300000 }));
    storeObservation(db, makeObservation({ title: 'Global', project: undefined, timestamp_epoch: 1704067400000 }));

    const alphaRows = getRecentObservations(db, 10, 'alpha');
    const betaRows = getRecentObservations(db, 10, 'beta');
    const globalRows = getRecentObservations(db, 10); // undefined = global only

    expect(alphaRows).toHaveLength(1);
    expect(alphaRows[0]!.title).toBe('Alpha');

    expect(betaRows).toHaveLength(1);
    expect(betaRows[0]!.title).toBe('Beta');

    expect(globalRows).toHaveLength(1);
    expect(globalRows[0]!.title).toBe('Global');
    expect(globalRows[0]!.project).toBeUndefined();
  });

  it('getRecentObservations with project=null also returns only global rows (explicit global contract)', () => {
    storeObservation(db, makeObservation({ title: 'Global', project: undefined, timestamp_epoch: 1704067200000 }));
    storeObservation(db, makeObservation({ title: 'Project', project: 'my-proj', timestamp_epoch: 1704067300000 }));

    const rows = getRecentObservations(db, 10, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Global');
  });
});
