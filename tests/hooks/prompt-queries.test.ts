/**
 * Claudex v2 — Prompt Query Helpers Tests (C18)
 *
 * Verifies that queryFts5 and getRecent use async import() instead of
 * require(), and that the functions are properly async.
 */

import { describe, it, expect } from 'vitest';
import { queryFts5, getRecent, extractKeywords, extractRecentFiles } from '../../src/hooks/_prompt-queries.js';

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
