/**
 * Claudex v2 — Context Assembler (WP-16)
 *
 * Builds the injection payload from hologram scores, FTS5 search results,
 * and recent observations into a token-budgeted markdown string.
 *
 * Assembly priority (highest first):
 * 1. Identity context (AGENT.md, USER.md)
 * 2. Project context (primer, handoff)
 * 3. HOT files (pressure >= 0.851)
 * 4. Relevant observations (FTS5 top-ranked)
 * 5. Session continuity (post-compaction)
 * 6. WARM files (pressure >= 0.426)
 * 7. Recent observations (fallback)
 *
 * Never throws — returns empty AssembledContext on error.
 */

import type {
  ContextSources,
  AssembledContext,
  ScoredFile,
  Observation,
  SearchResult,
} from '../shared/types.js';

// =============================================================================
// Token estimation
// =============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// =============================================================================
// Time formatting
// =============================================================================

function formatTimeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs * 1000;
  const minutes = Math.floor(diffMs / 60_000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// =============================================================================
// Section builders
// =============================================================================

function buildIdentitySection(sources: ContextSources): string {
  const parts: string[] = [];
  if (sources.identity?.agent) {
    parts.push(`- Agent: ${sources.identity.agent}`);
  }
  if (sources.identity?.user) {
    parts.push(`- User: ${sources.identity.user}`);
  }
  if (parts.length === 0) return '';
  return `## Identity\n${parts.join('\n')}\n`;
}

function buildProjectSection(sources: ContextSources): string {
  if (sources.scope.type !== 'project') return '';
  const parts: string[] = [];
  if (sources.projectContext?.primer) {
    parts.push(`- Primer: ${sources.projectContext.primer}`);
  }
  if (sources.projectContext?.handoff) {
    parts.push(`- Handoff: ${sources.projectContext.handoff}`);
  }
  if (parts.length === 0) return '';
  return `## Project (${sources.scope.name})\n${parts.join('\n')}\n`;
}

function buildHotSection(hotFiles: ScoredFile[]): string {
  if (hotFiles.length === 0) return '';
  const lines = hotFiles.map(
    f => `- \`${f.path}\` — HOT (pressure: ${f.raw_pressure.toFixed(2)})`,
  );
  return `## Active Focus\n${lines.join('\n')}\n`;
}

function buildSearchSection(results: SearchResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map(r => {
    const ago = formatTimeAgo(r.observation.timestamp_epoch);
    const cat = r.observation.category.charAt(0).toUpperCase() + r.observation.category.slice(1);
    return `- [${ago}] ${cat}: ${r.observation.title}`;
  });
  return `## Related Observations\n${lines.join('\n')}\n`;
}

function buildPostCompactionSection(): string {
  return `## Session Continuity\n- Context was recently compacted. Prior conversation state has been summarized.\n`;
}

function buildWarmSection(warmFiles: ScoredFile[]): string {
  if (warmFiles.length === 0) return '';
  const paths = warmFiles.map(f => `\`${f.path}\``).join(', ');
  return `## Warm Context\n- ${paths}\n`;
}

function buildRecentObservationsSection(observations: Observation[]): string {
  if (observations.length === 0) return '';
  const lines = observations.map(o => {
    const ago = formatTimeAgo(o.timestamp_epoch);
    const cat = o.category.charAt(0).toUpperCase() + o.category.slice(1);
    return `- [${ago}] ${cat}: ${o.title}`;
  });
  return `## Recent Activity\n${lines.join('\n')}\n`;
}

// =============================================================================
// Main assembler
// =============================================================================

export function assembleContext(
  sources: ContextSources,
  config: { maxTokens: number },
): AssembledContext {
  try {
    const contributedSources: string[] = [];

    // Check if all sources are empty
    const hasHologram = sources.hologram !== null &&
      (sources.hologram.hot.length > 0 || sources.hologram.warm.length > 0);
    const hasSearch = sources.searchResults.length > 0;
    const hasRecent = sources.recentObservations.length > 0;
    const hasIdentity = !!(sources.identity?.agent || sources.identity?.user);
    const hasProject = sources.scope.type === 'project' &&
      !!(sources.projectContext?.primer || sources.projectContext?.handoff);

    if (!hasHologram && !hasSearch && !hasRecent && !hasIdentity && !hasProject && !sources.postCompaction) {
      return { markdown: '', tokenEstimate: 0, sources: [] };
    }

    // Build sections in priority order. Each section is appended only if
    // it fits within the remaining character budget.
    const header = '# Context (auto-injected by Claudex)\n\n';
    let assembled = header;

    function tryAppend(section: string, source?: string): boolean {
      if (!section) return false;
      if (estimateTokens(assembled + section) > config.maxTokens) return false;
      assembled += section + '\n';
      if (source && !contributedSources.includes(source)) {
        contributedSources.push(source);
      }
      return true;
    }

    // 1. Identity (lightweight, always fits)
    if (hasIdentity) {
      tryAppend(buildIdentitySection(sources), 'identity');
    }

    // 2. Project context
    if (hasProject) {
      tryAppend(buildProjectSection(sources), 'project');
    }

    // 3. HOT files
    if (hasHologram && sources.hologram!.hot.length > 0) {
      tryAppend(buildHotSection(sources.hologram!.hot), 'hologram');
    }

    // 4. FTS5 search results
    if (hasSearch) {
      tryAppend(buildSearchSection(sources.searchResults), 'fts5');
    }

    // 5. Post-compaction continuity
    if (sources.postCompaction) {
      tryAppend(buildPostCompactionSection(), 'session');
    }

    // 6. WARM files
    if (hasHologram && sources.hologram!.warm.length > 0) {
      tryAppend(buildWarmSection(sources.hologram!.warm), 'hologram');
    }

    // 7. Fallback: recent observations (only if no hologram AND no FTS5)
    if (!hasHologram && !hasSearch && hasRecent) {
      tryAppend(buildRecentObservationsSection(sources.recentObservations), 'recency');
    }

    // If only the header was added (nothing fit), return empty
    if (assembled === header) {
      return { markdown: '', tokenEstimate: 0, sources: [] };
    }

    const markdown = assembled.trimEnd() + '\n';
    return {
      markdown,
      tokenEstimate: estimateTokens(markdown),
      sources: contributedSources,
    };
  } catch {
    return { markdown: '', tokenEstimate: 0, sources: [] };
  }
}
