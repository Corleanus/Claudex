import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assembleContext } from '../../src/lib/context-assembler.js';
import type {
  ContextSources,
  Observation,
  SearchResult,
  ScoredFile,
  Scope,
} from '../../src/shared/types.js';

// Mock logger
vi.mock('../../src/shared/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// Helpers
// =============================================================================

const GLOBAL_SCOPE: Scope = { type: 'global' };
const PROJECT_SCOPE: Scope = { type: 'project', name: 'my-app', path: '/work/my-app' };

function emptySources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    hologram: null,
    searchResults: [],
    recentObservations: [],
    scope: GLOBAL_SCOPE,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    session_id: 'sess-001',
    timestamp: '2023-11-14T22:00:00.000Z',
    timestamp_epoch: Date.now() - 30000, // 30 seconds ago
    tool_name: 'Read',
    category: 'discovery',
    title: 'Test observation',
    content: 'Test content',
    importance: 3,
    ...overrides,
  };
}

function makeSearchResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    observation: makeObservation(),
    rank: -1.5,
    snippet: 'matched <b>term</b>',
    ...overrides,
  };
}

function makeScoredFile(overrides: Partial<ScoredFile> = {}): ScoredFile {
  return {
    path: '/src/index.ts',
    raw_pressure: 0.9,
    temperature: 'HOT',
    system_bucket: 1,
    pressure_bucket: 1,
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('assembleContext', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty string when no sources provided', () => {
    const result = assembleContext(emptySources(), { maxTokens: 4000 });
    expect(result.markdown).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.sources).toEqual([]);
  });

  it('handles empty sources array gracefully, no crash', () => {
    const result = assembleContext(emptySources({
      searchResults: [],
      recentObservations: [],
    }), { maxTokens: 4000 });

    expect(result.markdown).toBe('');
    expect(result.tokenEstimate).toBe(0);
  });

  it('assembly respects priority order (identity first, recent before consensus)', () => {
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'Claudex', user: 'Dev' },
      projectContext: { primer: 'Project primer content', handoff: 'Handoff notes' },
      recentObservations: [makeObservation({ title: 'Recent activity' })],
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'Search result' }) })],
      consensusDecisions: [{
        session_id: 'sess-001',
        timestamp: '2023-11-14T22:00:00.000Z',
        timestamp_epoch: Date.now() - 60000,
        title: 'Decision',
        description: 'A consensus decision',
        status: 'active',
      }],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    const md = result.markdown;

    // Verify priority order: identity < project < search < recent < consensus
    const identityIdx = md.indexOf('## Identity');
    const projectIdx = md.indexOf('## Project');
    const searchIdx = md.indexOf('## Related Observations');
    const recentIdx = md.indexOf('## Recent Activity');
    const consensusIdx = md.indexOf('## Consensus Decisions');

    expect(identityIdx).toBeGreaterThan(-1);
    expect(projectIdx).toBeGreaterThan(-1);
    expect(searchIdx).toBeGreaterThan(-1);
    expect(recentIdx).toBeGreaterThan(-1);
    expect(consensusIdx).toBeGreaterThan(-1);

    expect(identityIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(searchIdx);
    expect(searchIdx).toBeLessThan(recentIdx);
    expect(recentIdx).toBeLessThan(consensusIdx);
  });

  it('token budget: stops adding sections when budget exceeded', () => {
    // Very small budget — only the header + maybe identity should fit
    const sources = emptySources({
      identity: { agent: 'Claudex', user: 'Dev' },
      searchResults: [makeSearchResult()],
      recentObservations: [makeObservation()],
      hologram: {
        hot: [makeScoredFile()],
        warm: [makeScoredFile({ path: '/src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
    });

    // Budget of 20 tokens ~ 80 chars — header alone is ~45 chars
    const result = assembleContext(sources, { maxTokens: 20 });

    // The result should be truncated — not all sections should be present
    // The markdown should be shorter than what it would be with a large budget
    const fullResult = assembleContext(sources, { maxTokens: 100000 });
    expect(result.markdown.length).toBeLessThan(fullResult.markdown.length);
  });

  it('token estimation: roughly ceil(text.length / 4)', () => {
    const sources = emptySources({
      identity: { agent: 'Claudex' },
    });

    const result = assembleContext(sources, { maxTokens: 4000 });

    // tokenEstimate should be approximately ceil(markdown.length / 4)
    const expectedTokens = Math.ceil(result.markdown.length / 4);
    expect(result.tokenEstimate).toBe(expectedTokens);
  });

  it('large content respects token ceiling (4000 tokens max)', () => {
    // Build sources that would generate way more than 4000 tokens
    const manyResults: SearchResult[] = [];
    for (let i = 0; i < 100; i++) {
      manyResults.push(makeSearchResult({
        observation: makeObservation({
          title: `Observation ${i} with a very long title that takes up lots of tokens padding padding padding`,
          content: 'x'.repeat(200),
        }),
      }));
    }

    const sources = emptySources({
      identity: { agent: 'Claudex', user: 'Developer' },
      searchResults: manyResults,
      hologram: {
        hot: Array.from({ length: 20 }, (_, i) =>
          makeScoredFile({ path: `/src/hot-${i}.ts`, raw_pressure: 0.9 }),
        ),
        warm: Array.from({ length: 20 }, (_, i) =>
          makeScoredFile({ path: `/src/warm-${i}.ts`, raw_pressure: 0.5, temperature: 'WARM' }),
        ),
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.tokenEstimate).toBeLessThanOrEqual(4000);
  });

  it('recent observations included even when hologram and FTS5 present', () => {
    // H16 fix: recent observations should be in priority order, not fallback-only
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: [makeScoredFile({ path: '/src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'FTS5 result' }) })],
      recentObservations: [makeObservation({ title: 'Recent work' })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });

    // Recent observations should be present even though hologram and FTS5 exist
    expect(result.markdown).toContain('## Recent Activity');
    expect(result.markdown).toContain('Recent work');
    expect(result.sources).toContain('recency');
  });

  it('token budget accounts for newlines between sections', () => {
    // H17 fix: newlines should be included in budget calculation
    const sources = emptySources({
      identity: { agent: 'Test' },
      recentObservations: [makeObservation({ title: 'x'.repeat(100) })],
    });

    // Very tight budget — should account for newlines correctly
    const result = assembleContext(sources, { maxTokens: 50 });

    // Token estimate should not exceed budget
    expect(result.tokenEstimate).toBeLessThanOrEqual(50);
  });
});

// =============================================================================
// formatTimeAgo tests
// =============================================================================

describe('formatTimeAgo (via assembled output)', () => {
  // formatTimeAgo is not exported, so we test it indirectly through assembleContext
  // by inserting observations with specific timestamp_epochs and examining output

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('"just now" for < 60 seconds (< 60000ms)', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const sources = emptySources({
      // No hologram, no search — recentObservations is the fallback
      recentObservations: [makeObservation({
        title: 'Very recent',
        timestamp_epoch: now - 30000, // 30 seconds ago
      })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('just now');
  });

  it('"Xm ago" for minutes', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const sources = emptySources({
      recentObservations: [makeObservation({
        title: 'Five minutes ago',
        timestamp_epoch: now - 5 * 60_000, // 5 minutes ago
      })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('5m ago');
  });

  it('"Xh ago" for hours', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const sources = emptySources({
      recentObservations: [makeObservation({
        title: 'Two hours ago',
        timestamp_epoch: now - 2 * 60 * 60_000, // 2 hours ago
      })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('2h ago');
  });

  it('"Xd ago" for days', () => {
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const sources = emptySources({
      recentObservations: [makeObservation({
        title: 'Three days ago',
        timestamp_epoch: now - 3 * 24 * 60 * 60_000, // 3 days ago
      })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('3d ago');
  });

  it('does NOT multiply timestamp_epoch by 1000 (timestamp is already ms)', () => {
    // This tests fix #2: if the code mistakenly treated epoch as seconds
    // and multiplied by 1000, a recent timestamp would appear as far in the future
    // and Date.now() - futureMs would be negative, producing broken output.
    const now = 1700000000000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    const sources = emptySources({
      recentObservations: [makeObservation({
        title: 'Recent observation',
        timestamp_epoch: now - 120_000, // 2 minutes ago in ms
      })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    // If code multiplied by 1000, the diff would be negative, breaking the "Xm ago" logic.
    // Correct behavior: 120000ms = 2 minutes → "2m ago"
    expect(result.markdown).toContain('2m ago');
    // Should NOT contain "just now" (which would happen if epoch was treated incorrectly)
    // Should NOT contain negative or absurd values
    expect(result.markdown).not.toMatch(/\d{4,}[mhd] ago/); // no absurdly large time values
  });
});

// =============================================================================
// Source tracking tests
// =============================================================================

describe('source tracking', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes identity in sources when identity data provided', () => {
    const sources = emptySources({
      identity: { agent: 'Claudex' },
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('identity');
  });

  it('includes project in sources when project scope', () => {
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      projectContext: { primer: 'content' },
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('project');
  });

  it('includes hologram in sources when hot files present', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile()],
        warm: [],
        cold: [],
      },
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('hologram');
  });

  it('includes fts5 in sources when search results present', () => {
    const sources = emptySources({
      searchResults: [makeSearchResult()],
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('fts5');
  });

  it('includes session in sources when postCompaction is true', () => {
    const sources = emptySources({
      postCompaction: true,
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('session');
  });

  it('includes recency in sources when recent observations are fallback', () => {
    const sources = emptySources({
      // No hologram, no search — recentObservations is the fallback
      recentObservations: [makeObservation()],
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('recency');
  });
});
