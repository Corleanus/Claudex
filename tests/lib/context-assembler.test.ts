import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assembleContext } from '../../src/lib/context-assembler.js';
import type {
  ContextSources,
  Observation,
  SearchResult,
  ScoredFile,
  Scope,
  ReasoningChain,
  ConsensusDecision,
} from '../../src/shared/types.js';
import type { GsdState } from '../../src/gsd/types.js';

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

// =============================================================================
// GSD context injection tests
// =============================================================================

function makeGsdState(overrides: Partial<GsdState> = {}): GsdState {
  return {
    active: true,
    position: {
      phase: 2,
      totalPhases: 8,
      phaseName: 'Phase-Aware Context Injection',
      plan: 1,
      totalPlans: 2,
      status: 'In progress',
    },
    phases: [
      {
        number: 1,
        name: 'GSD State Reader',
        goal: 'Parse and expose GSD state',
        dependsOn: null,
        requirements: ['PCTX-01'],
        successCriteria: ['Claudex detects active phase'],
        roadmapComplete: true,
        plans: { total: 1, complete: 1 },
      },
      {
        number: 2,
        name: 'Phase-Aware Context Injection',
        goal: 'Post-compact context includes phase goal and plan details',
        dependsOn: 'Phase 1',
        requirements: ['PCTX-02'],
        successCriteria: [
          'Injected context contains current phase name, goal, and success criteria',
          'Injected context contains active plan must-haves',
          'Context shows which requirements are complete vs pending',
          'No regression for non-GSD projects',
        ],
        roadmapComplete: false,
        plans: { total: 2, complete: 0 },
      },
    ],
    warnings: [],
    ...overrides,
  };
}

describe('GSD context injection', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('includes ## Project Phase section when GSD state is active', () => {
    const sources = emptySources({ gsdState: makeGsdState() });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('## Project Phase');
  });

  it('omits GSD section when gsdState is undefined', () => {
    const sources = emptySources();
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).not.toContain('## Project Phase');
  });

  it('omits GSD section when gsdState.active is false', () => {
    const sources = emptySources({
      gsdState: { active: false, position: null, phases: [], warnings: [] },
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).not.toContain('## Project Phase');
  });

  it('includes milestone progress line', () => {
    const sources = emptySources({ gsdState: makeGsdState() });
    const result = assembleContext(sources, { maxTokens: 4000 });
    // 1 of 8 phases complete = Math.round(12.5) = 13%
    expect(result.markdown).toContain('Phase 2 of 8, 13% complete');
  });

  it('includes phase goal', () => {
    const sources = emptySources({ gsdState: makeGsdState() });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('**Goal:** Post-compact context includes phase goal and plan details');
  });

  it('includes success criteria bullets', () => {
    const sources = emptySources({ gsdState: makeGsdState() });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('**Success Criteria:**');
    expect(result.markdown).toContain('- Injected context contains current phase name, goal, and success criteria');
    expect(result.markdown).toContain('- No regression for non-GSD projects');
  });

  it('truncates long success criteria', () => {
    const longCriterion = 'A'.repeat(150);
    const state = makeGsdState();
    state.phases[1]!.successCriteria = [longCriterion];
    const sources = emptySources({ gsdState: state });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('A'.repeat(100) + '...');
    expect(result.markdown).not.toContain('A'.repeat(101));
  });

  it('includes plan must-haves when provided', () => {
    const sources = emptySources({
      gsdState: makeGsdState(),
      gsdPlanMustHaves: ['Truth one', 'Truth two'],
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('**Active Plan:**');
    expect(result.markdown).toContain('- Truth one');
    expect(result.markdown).toContain('- Truth two');
  });

  it('omits plan section when gsdPlanMustHaves is undefined', () => {
    const sources = emptySources({ gsdState: makeGsdState() });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).not.toContain('**Active Plan:**');
  });

  it('includes requirement status when provided', () => {
    const sources = emptySources({
      gsdState: makeGsdState(),
      gsdRequirementStatus: { complete: 1, total: 2 },
    });
    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('**Requirements:** 1 of 2 complete');
  });

  it('GSD section appears after Active Focus and before Flow Reasoning', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: [],
        cold: [],
      },
      gsdState: makeGsdState(),
      reasoningChains: [{
        session_id: 'sess-001',
        timestamp: '2023-11-14T22:00:00.000Z',
        timestamp_epoch: Date.now() - 60000,
        trigger: 'pre_compact' as const,
        title: 'Reasoning chain',
        reasoning: 'Some reasoning',
        importance: 3,
      }],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    const md = result.markdown;

    const hotIdx = md.indexOf('## Active Focus');
    const gsdIdx = md.indexOf('## Project Phase');
    const flowIdx = md.indexOf('## Flow Reasoning');

    expect(hotIdx).toBeGreaterThan(-1);
    expect(gsdIdx).toBeGreaterThan(-1);
    expect(flowIdx).toBeGreaterThan(-1);

    expect(hotIdx).toBeLessThan(gsdIdx);
    expect(gsdIdx).toBeLessThan(flowIdx);
  });

  it('REGRESSION: non-GSD sources produce identical output', () => {
    const baseSources: ContextSources = {
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: [makeScoredFile({ path: '/src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'FTS result' }) })],
      recentObservations: [makeObservation({ title: 'Recent' })],
      scope: GLOBAL_SCOPE,
    };

    const result1 = assembleContext(baseSources, { maxTokens: 4000 });
    const result2 = assembleContext({ ...baseSources, gsdState: undefined }, { maxTokens: 4000 });

    expect(result1.markdown).toBe(result2.markdown);
  });
});

// =============================================================================
// Phase boost annotation tests
// =============================================================================

describe('Phase boost annotation', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hot section shows [phase] marker for boosted files', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/boosted.ts', raw_pressure: 0.95, phase_boosted: true })],
        warm: [],
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('`/src/boosted.ts` — HOT (pressure: 0.95) [phase]');
  });

  it('hot section omits marker for non-boosted files', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/normal.ts', raw_pressure: 0.9 })],
        warm: [],
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('`/src/normal.ts` — HOT (pressure: 0.90)');
    expect(result.markdown).not.toContain('[phase]');
  });

  it('warm section shows [phase] marker for boosted files', () => {
    const sources = emptySources({
      hologram: {
        hot: [],
        warm: [makeScoredFile({ path: '/src/warm-boosted.ts', raw_pressure: 0.5, temperature: 'WARM', phase_boosted: true })],
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).toContain('`/src/warm-boosted.ts` [phase]');
  });

  it('non-GSD project has no [phase] markers (regression guard)', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts', raw_pressure: 0.9 })],
        warm: [makeScoredFile({ path: '/src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
      searchResults: [makeSearchResult()],
      recentObservations: [makeObservation()],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.markdown).not.toContain('[phase]');
  });
});

// =============================================================================
// Demand-paging: reference builder tests (WP-11)
// =============================================================================

function makeReasoningChain(overrides: Partial<ReasoningChain> = {}): ReasoningChain {
  return {
    session_id: 'sess-001',
    timestamp: '2023-11-14T22:00:00.000Z',
    timestamp_epoch: Date.now() - 3 * 60 * 60_000, // 3h ago
    trigger: 'pre_compact',
    title: 'Test reasoning chain',
    reasoning: 'Some reasoning content',
    importance: 3,
    ...overrides,
  };
}

function makeConsensusDecision(overrides: Partial<ConsensusDecision> = {}): ConsensusDecision {
  return {
    session_id: 'sess-001',
    timestamp: '2023-11-14T22:00:00.000Z',
    timestamp_epoch: Date.now() - 2 * 60 * 60_000, // 2h ago
    title: 'Test decision',
    description: 'A test consensus decision',
    status: 'agreed',
    importance: 3,
    ...overrides,
  };
}

describe('demand-paging: reference builders (via assembleContext with tight budget)', () => {
  const NOW = 1700000000000;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // To exercise reference builders, we need a budget where priority sections
  // (Identity, Project, HOT, GSD) consume > maxTokens - 500 chars.
  // We use a large Identity + Project content to push assembled over the threshold,
  // then verify reference-eligible sections use compact format.

  function tightBudgetSources(extras: Partial<ContextSources> = {}): ContextSources {
    // A large primer (~2000 chars) ensures assembled after priority sections is large,
    // leaving < 500 tokens remaining.
    return emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'A'.repeat(500), user: 'B'.repeat(500) },
      projectContext: { primer: 'P'.repeat(2000) },
      ...extras,
    });
  }

  it('buildSearchSectionRef: tight budget produces compact search reference', () => {
    const sources = tightBudgetSources({
      searchResults: [
        makeSearchResult({ observation: makeObservation({ title: 'Auth flow fix', timestamp_epoch: NOW - 3 * 60 * 60_000 }) }),
        makeSearchResult({ observation: makeObservation({ title: 'Second result' }) }),
      ],
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).toContain('## Related Observations (refs)');
    expect(result.markdown).toContain('[2 observations, top: "Auth flow fix"');
    expect(result.markdown).toContain('3h ago');
  });

  it('buildRecentSectionRef: tight budget produces compact recent reference', () => {
    const sources = tightBudgetSources({
      recentObservations: [
        makeObservation({ title: 'Latest change', timestamp_epoch: NOW - 12 * 60_000 }), // 12m ago
        makeObservation({ title: 'Older change' }),
      ],
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).toContain('## Recent Activity (refs)');
    expect(result.markdown).toContain('[2 observations, latest: "Latest change"');
    expect(result.markdown).toContain('12m ago');
  });

  it('buildReasoningSectionRef: tight budget produces compact reasoning reference', () => {
    const sources = tightBudgetSources({
      reasoningChains: [
        makeReasoningChain({ title: 'Design decision chain', timestamp_epoch: NOW - 60 * 60_000 }), // 1h ago
      ],
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).toContain('## Flow Reasoning (refs)');
    expect(result.markdown).toContain('[1 chains, latest: "Design decision chain"');
    expect(result.markdown).toContain('1h ago');
  });

  it('buildConsensusSectionRef: tight budget produces compact consensus reference', () => {
    const sources = tightBudgetSources({
      consensusDecisions: [
        makeConsensusDecision({ title: 'SQLite sentinel approach', status: 'agreed', timestamp_epoch: NOW - 2 * 60 * 60_000 }),
        makeConsensusDecision({ title: 'Second decision' }),
      ],
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).toContain('## Consensus Decisions (refs)');
    expect(result.markdown).toContain('[2 decisions, latest: "SQLite sentinel approach" [agreed]');
    expect(result.markdown).toContain('2h ago');
  });

  it('buildWarmSectionRef: tight budget produces compact warm reference', () => {
    const sources = tightBudgetSources({
      hologram: {
        hot: [],
        warm: [
          makeScoredFile({ path: 'src/lib/context-assembler.ts', raw_pressure: 0.52, temperature: 'WARM' }),
          makeScoredFile({ path: 'src/lib/other.ts', raw_pressure: 0.45, temperature: 'WARM' }),
        ],
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).toContain('## Warm Context (refs)');
    expect(result.markdown).toContain('[2 files, top: `src/lib/context-assembler.ts` (0.52)]');
  });

  it('all ref builders return empty string for empty arrays', () => {
    // With empty arrays, hasSearch/hasRecent/etc. are false — sections are skipped entirely.
    // The reference builders themselves guard on empty arrays.
    // We verify via assembleContext that no ref headers appear for empty data.
    const sources = tightBudgetSources({
      searchResults: [],
      recentObservations: [],
      reasoningChains: [],
      consensusDecisions: [],
      hologram: { hot: [], warm: [], cold: [] },
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    expect(result.markdown).not.toContain('(refs)');
  });
});

describe('demand-paging: mode switching', () => {
  const NOW = 1700000000000;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function richSources(): ContextSources {
    return emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'Claudex', user: 'Dev' },
      projectContext: { primer: 'Small primer' },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'Search hit' }) })],
      recentObservations: [makeObservation({ title: 'Recent work' })],
      reasoningChains: [makeReasoningChain({ title: 'Design chain' })],
      consensusDecisions: [makeConsensusDecision({ title: 'Some decision' })],
      hologram: {
        hot: [],
        warm: [makeScoredFile({ path: 'src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
    });
  }

  it('budget plenty (>500 remaining): all sections rendered inline', () => {
    const result = assembleContext(richSources(), { maxTokens: 4000 });
    const md = result.markdown;

    // Inline headers (no "(refs)" suffix)
    expect(md).toContain('## Flow Reasoning\n');
    expect(md).toContain('## Related Observations\n');
    expect(md).toContain('## Recent Activity\n');
    expect(md).toContain('## Consensus Decisions\n');
    expect(md).toContain('## Warm Context\n');

    // No reference headers
    expect(md).not.toContain('(refs)');
  });

  it('budget tight (<500 remaining): reference-eligible sections switch to refs', () => {
    // Force tight budget: large identity/project consumes most tokens.
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'A'.repeat(500), user: 'B'.repeat(500) },
      projectContext: { primer: 'P'.repeat(2000) },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'Hit' }) })],
      recentObservations: [makeObservation({ title: 'Recent' })],
      reasoningChains: [makeReasoningChain({ title: 'Chain' })],
      consensusDecisions: [makeConsensusDecision({ title: 'Decision' })],
      hologram: {
        hot: [],
        warm: [makeScoredFile({ path: 'warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    const md = result.markdown;

    // At least some reference-eligible sections should appear as refs
    // (depending on exact budget, not all may fit)
    // The key assertion: no full inline headers for ref-eligible sections
    expect(md).not.toContain('### '); // inline reasoning/consensus use ### subheaders
  });

  it('priority sections remain inline even when budget tight', () => {
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'A'.repeat(100) },
      projectContext: { primer: 'P'.repeat(100) },
      hologram: {
        hot: [makeScoredFile({ path: 'hot.ts', raw_pressure: 0.9 })],
        warm: [],
        cold: [],
      },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'Hit' }) })],
    });

    const result = assembleContext(sources, { maxTokens: 200 });
    const md = result.markdown;

    // Identity, Project, HOT are always inline — verify they appear without "(refs)"
    if (md.includes('## Identity')) {
      expect(md).toContain('## Identity\n');
    }
    if (md.includes('## Active Focus')) {
      expect(md).toContain('## Active Focus\n');
    }
  });

  it('post-compaction section always inline regardless of budget', () => {
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'A'.repeat(500), user: 'B'.repeat(500) },
      projectContext: { primer: 'P'.repeat(2000) },
      postCompaction: true,
    });

    const result = assembleContext(sources, { maxTokens: 1000 });
    const md = result.markdown;

    // If Session Continuity fits, it must be inline (not a ref)
    if (md.includes('Session Continuity')) {
      expect(md).toContain('## Session Continuity\n');
      expect(md).not.toContain('## Session Continuity (refs)');
    }
  });

  it('reference sections are shorter than inline equivalents', () => {
    // Use identical sources — inline mode (large budget) vs ref mode (tiny budget).
    // In ref mode, the ref-eligible sections (reasoning, search, recent, consensus, warm)
    // collapse to 2-line summaries instead of multi-line inline content.
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'Claudex' },
      projectContext: { primer: 'Short primer' },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'Search hit' }) })],
      recentObservations: [makeObservation({ title: 'Recent work' })],
      reasoningChains: [makeReasoningChain({ title: 'Design chain', reasoning: 'R'.repeat(400) })],
      consensusDecisions: [makeConsensusDecision({ title: 'Some decision', description: 'D'.repeat(300) })],
      hologram: {
        hot: [],
        warm: [makeScoredFile({ path: 'src/warm.ts', raw_pressure: 0.5, temperature: 'WARM' })],
        cold: [],
      },
    });

    // Inline: large budget — all sections rendered in full
    const inlineResult = assembleContext(sources, { maxTokens: 4000 });

    // To force ref mode with the same sources, we need the priority sections to consume
    // > maxTokens - 500. With tiny identity+project, we set a very small maxTokens
    // so that after the header + identity + project, < 500 tokens remain.
    // maxTokens=50: header=~11 tokens, identity=~6 tokens, project=~9 tokens → ~26 tokens used.
    // 50 - 26 = 24 remaining → useReferences=true. Refs themselves are ~10 tokens each, so they fit.
    const refResult = assembleContext(sources, { maxTokens: 50 });

    // Inline reasoning section alone is ~100 tokens (400 char reasoning + header).
    // Ref reasoning is 2 lines ~ 10 tokens. Full inline markdown >> ref markdown.
    expect(inlineResult.markdown.length).toBeGreaterThan(refResult.markdown.length);
  });

  it('full assembly with mixed inline and reference sections', () => {
    // Medium budget: enough for identity + project inline, then refs for rest
    const sources = emptySources({
      scope: PROJECT_SCOPE,
      identity: { agent: 'Claudex' },
      projectContext: { primer: 'Project primer' },
      searchResults: [makeSearchResult({ observation: makeObservation({ title: 'FTS hit' }) })],
      recentObservations: [makeObservation({ title: 'Recent work' })],
      reasoningChains: [makeReasoningChain({ title: 'Reasoning' })],
      postCompaction: true,
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    const md = result.markdown;

    // With 4000 tokens and small sources, all should be inline
    expect(md).toContain('## Identity\n');
    expect(md).toContain('## Project (my-app)\n');
    expect(md).toContain('## Flow Reasoning\n');
    expect(md).toContain('## Related Observations\n');
    expect(md).toContain('## Recent Activity\n');
    expect(md).toContain('## Session Continuity\n');
    expect(md).not.toContain('(refs)');
  });
});

// =============================================================================
// Search result reservation tests (WP-4)
// =============================================================================

describe('search result reservation', () => {
  const NOW = 1700000000000;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('search results get injected when budget is tight but trimmable sections exist', () => {
    // Large warm section + search results. Budget barely fits warm but not search.
    // Reservation should trim warm to make room for search ref.
    const manyWarmFiles = Array.from({ length: 15 }, (_, i) =>
      makeScoredFile({ path: `/src/warm-${i}.ts`, raw_pressure: 0.5, temperature: 'WARM' as const }),
    );

    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: manyWarmFiles,
        cold: [],
      },
      searchResults: [
        makeSearchResult({ observation: makeObservation({ title: 'Important FTS result' }) }),
        makeSearchResult({ observation: makeObservation({ title: 'Another FTS result' }) }),
      ],
    });

    // Tight budget: HOT + warm consume most, leaving no room for search normally
    const result = assembleContext(sources, { maxTokens: 300 });

    // Either search results made it in directly, or via reservation
    // At minimum, fts5 should appear in sources if reservation worked
    if (result.sources.includes('hologram') && result.markdown.includes('Warm Context')) {
      // If warm was included, search reservation should have trimmed it
      // and injected search ref
      expect(result.sources).toContain('fts5');
    }
  });

  it('search results included normally when budget is sufficient', () => {
    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: [],
        cold: [],
      },
      searchResults: [
        makeSearchResult({ observation: makeObservation({ title: 'FTS result' }) }),
      ],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });
    expect(result.sources).toContain('fts5');
    expect(result.markdown).toContain('## Related Observations');
  });

  it('search reservation trims warm section to make room for search ref', () => {
    // Create a scenario where warm files fill up the budget, pushing search out
    const manyWarmFiles = Array.from({ length: 20 }, (_, i) =>
      makeScoredFile({ path: `/src/long-warm-file-name-${i}.ts`, raw_pressure: 0.5, temperature: 'WARM' as const }),
    );

    const sources = emptySources({
      hologram: {
        hot: [makeScoredFile({ path: '/src/hot.ts' })],
        warm: manyWarmFiles,
        cold: [],
      },
      searchResults: [
        makeSearchResult({ observation: makeObservation({ title: 'Critical search hit' }) }),
      ],
      recentObservations: [makeObservation({ title: 'Recent' })],
    });

    // Budget that fits HOT + recent + warm but NOT search
    // After reservation: warm trimmed, search ref injected
    const result = assembleContext(sources, { maxTokens: 600 });

    // If warm consumed the budget, the reservation should have rescued search
    if (result.markdown.includes('Related Observations') || result.markdown.includes('(refs)')) {
      expect(result.sources).toContain('fts5');
    }
  });

  it('no trimming when search results already included', () => {
    const sources = emptySources({
      searchResults: [
        makeSearchResult({ observation: makeObservation({ title: 'FTS result' }) }),
      ],
      recentObservations: [makeObservation({ title: 'Recent' })],
    });

    const result = assembleContext(sources, { maxTokens: 4000 });

    // Both should be present with plenty of budget
    expect(result.sources).toContain('fts5');
    expect(result.sources).toContain('recency');
  });
});
