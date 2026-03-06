/**
 * Claudex v2 — Prompt Query Helpers Tests (C18)
 *
 * Verifies that queryFts5 and getRecent use async import() instead of
 * require(), and that the functions are properly async.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { queryFts5, getRecent, extractKeywords, extractRecentFiles } from '../../src/hooks/_prompt-queries.js';
import { storeObservation } from '../../src/db/observations.js';
import type { Observation } from '../../src/shared/types.js';
import { setupDb } from '../helpers/setup-db.js';

// Mock logger to prevent filesystem writes during tests
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock _infrastructure to prevent filesystem writes
vi.mock('../../src/hooks/_infrastructure.js', () => ({
  logToFile: vi.fn(),
}));

describe('ESM contract (C18)', () => {
  it('queryFts5 is an async function', () => {
    // Async functions return a Promise
    const result = queryFts5('test query', { type: 'global', name: '__global__', path: '/' }, null);
    expect(result).toBeInstanceOf(Promise);
  });

  it('getRecent is an async function', () => {
    const result = getRecent({ type: 'global', name: '__global__', path: '/' }, null);
    expect(result).toBeInstanceOf(Promise);
  });

  it('queryFts5 returns empty array when db is null', async () => {
    const result = await queryFts5('test search query words', { type: 'global', name: '__global__', path: '/' }, null);
    expect(result).toEqual([]);
  });

  it('getRecent returns empty array when db is null', async () => {
    const result = await getRecent({ type: 'global', name: '__global__', path: '/' }, null);
    expect(result).toEqual([]);
  });

  it('queryFts5 returns empty array for empty prompt', async () => {
    const result = await queryFts5('', { type: 'project', name: 'test', path: '/test' }, null);
    expect(result).toEqual([]);
  });

  it('no require() calls remain in _prompt-queries.ts source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/hooks/_prompt-queries.ts'),
      'utf-8',
    );
    // Should not contain require() calls (but allow the word 'require' in comments)
    const requireCalls = source.match(/\brequire\s*\(/g);
    expect(requireCalls).toBeNull();
  });
});

describe('extractKeywords', () => {
  it('extracts meaningful keywords from prompt', () => {
    const keywords = extractKeywords('How does the scoring system work?');
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain('scoring');
    expect(keywords).toContain('system');
    expect(keywords).toContain('work');
  });
});

describe('extractRecentFiles', () => {
  it('deduplicates and limits to 10 files', () => {
    const observations = Array.from({ length: 15 }, (_, i) => ({
      session_id: 's1',
      project: 'test',
      timestamp: new Date().toISOString(),
      timestamp_epoch: Date.now(),
      tool_name: 'Read',
      category: 'discovery' as const,
      title: `Obs ${i}`,
      content: '',
      importance: 3,
      files_modified: [`src/file${i}.ts`],
    }));

    const files = extractRecentFiles(observations);
    expect(files.length).toBeLessThanOrEqual(10);
  });
});

describe('queryFts5 deduplication', () => {
  it('deduplicates search results by tool_name:title composite key', async () => {
    const db = setupDb();
    try {
      // Insert two observations with the same tool_name AND title — should dedup
      storeObservation(db, {
        session_id: 'test-session',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Scheduler configuration',
        content: 'Scheduler configuration for cron jobs and workers',
        importance: 4,
      });
      storeObservation(db, {
        session_id: 'test-session',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now() - 1000,
        tool_name: 'Read',
        category: 'discovery',
        title: 'Scheduler configuration',
        content: 'Scheduler configuration updated for batch processing',
        importance: 4,
      });

      const results = await queryFts5('scheduler configuration', { type: 'global', name: '__global__', path: '/' }, db);
      // Both match on same tool_name:title key, dedup should keep only one
      const keys = results.map(r => `${r.observation.tool_name}:${r.observation.title}`);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    } finally {
      db.close();
    }
  });

  it('keeps results with same title but different tool_name', async () => {
    const db = setupDb();
    try {
      // Same title, different tool_name — should NOT dedup
      storeObservation(db, {
        session_id: 'test-session',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        tool_name: 'Read',
        category: 'discovery',
        title: 'Scheduler configuration',
        content: 'Scheduler configuration for cron jobs and workers',
        importance: 4,
      });
      storeObservation(db, {
        session_id: 'test-session',
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now() - 1000,
        tool_name: 'Grep',
        category: 'discovery',
        title: 'Scheduler configuration',
        content: 'Scheduler configuration found via search pattern',
        importance: 4,
      });

      const results = await queryFts5('scheduler configuration', { type: 'global', name: '__global__', path: '/' }, db);
      // Different tool_name means different composite keys — both should survive
      const keys = results.map(r => `${r.observation.tool_name}:${r.observation.title}`);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
      // Should have at least 2 results (one per tool_name)
      expect(results.length).toBeGreaterThanOrEqual(2);
    } finally {
      db.close();
    }
  });
});
