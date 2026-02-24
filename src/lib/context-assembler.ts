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
 * 4. Flow Reasoning (reasoning chains)
 * 5. Relevant observations (FTS5 top-ranked)
 * 6. Recent observations (temporal context)
 * 7. Consensus Decisions
 * 8. Session continuity (post-compaction)
 * 9. WARM files (pressure >= 0.426)
 *
 * Never throws — returns empty AssembledContext on error.
 */

import type {
  ContextSources,
  AssembledContext,
  ScoredFile,
  Observation,
  SearchResult,
  ReasoningChain,
  ConsensusDecision,
} from '../shared/types.js';
import type { GsdState } from '../gsd/types.js';
import { redactAssemblyOutput } from './redaction.js';

// =============================================================================
// Token estimation
// =============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// =============================================================================
// Time formatting
// =============================================================================

// timestamp_epoch is always milliseconds (epoch ms)
function formatTimeAgo(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
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
  const lines = hotFiles.map(f => {
    const boost = f.phase_boosted ? ' [phase]' : '';
    return `- \`${f.path}\` — HOT (pressure: ${f.raw_pressure.toFixed(2)})${boost}`;
  });
  return `## Active Focus\n${lines.join('\n')}\n`;
}

function buildGsdSection(
  gsdState: GsdState,
  planMustHaves?: string[],
  requirementStatus?: { complete: number; total: number },
): string {
  if (!gsdState.active || !gsdState.position) return '';

  const pos = gsdState.position;
  const lines: string[] = [];

  // Milestone progress
  const completedCount = gsdState.phases.filter(p => p.roadmapComplete).length;
  const totalCount = pos.totalPhases;
  const pct = totalCount > 0 ? Math.round(completedCount / totalCount * 100) : 0;
  lines.push(`Phase ${pos.phase} of ${totalCount}, ${pct}% complete`);

  // Current phase name
  const currentPhase = gsdState.phases.find(p => p.number === pos.phase);
  const phaseName = pos.phaseName ?? currentPhase?.name ?? 'Unknown';
  lines.push(`**Current:** ${phaseName}`);

  // Goal
  if (currentPhase?.goal) {
    lines.push(`**Goal:** ${currentPhase.goal}`);
  }

  // Success criteria (up to 5, truncated to 100 chars)
  if (currentPhase?.successCriteria?.length) {
    lines.push('**Success Criteria:**');
    for (const criterion of currentPhase.successCriteria.slice(0, 5)) {
      const truncated = criterion.length > 100 ? criterion.slice(0, 100) + '...' : criterion;
      lines.push(`- ${truncated}`);
    }
  }

  // Plan must-haves
  if (planMustHaves?.length) {
    lines.push('**Active Plan:**');
    for (const truth of planMustHaves.slice(0, 3)) {
      lines.push(`- ${truth}`);
    }
  }

  // Requirement status
  if (requirementStatus && requirementStatus.total > 0) {
    lines.push(`**Requirements:** ${requirementStatus.complete} of ${requirementStatus.total} complete`);
  }

  return `## Project Phase\n${lines.join('\n')}\n`;
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

function buildReasoningSection(chains: ReasoningChain[]): string {
  if (chains.length === 0) return '';
  const lines = chains.map(c => {
    const ago = formatTimeAgo(c.timestamp_epoch);
    const truncated =
      c.reasoning.length > 500 ? c.reasoning.slice(0, 500) + '...' : c.reasoning;
    return `### ${c.title} (${ago})\n${truncated}\n`;
  });
  return `## Flow Reasoning\n${lines.join('\n')}\n`;
}

function buildConsensusSection(decisions: ConsensusDecision[]): string {
  if (decisions.length === 0) return '';
  const lines = decisions.map(d => {
    const ago = formatTimeAgo(d.timestamp_epoch);
    const truncated =
      d.description.length > 300 ? d.description.slice(0, 300) + '...' : d.description;
    return `### ${d.title} [${d.status}] (${ago})\n${truncated}\n`;
  });
  return `## Consensus Decisions\n${lines.join('\n')}\n`;
}

function buildPostCompactionSection(): string {
  return `## Session Continuity\n- Context was recently compacted. Prior conversation state has been summarized.\n`;
}

function buildWarmSection(warmFiles: ScoredFile[]): string {
  if (warmFiles.length === 0) return '';
  const paths = warmFiles.map(f => {
    const boost = f.phase_boosted ? ' [phase]' : '';
    return `\`${f.path}\`${boost}`;
  }).join(', ');
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
    const hasReasoning = !!(sources.reasoningChains?.length);
    const hasConsensus = !!(sources.consensusDecisions?.length);
    const hasGsd = !!(sources.gsdState?.active);

    if (!hasHologram && !hasSearch && !hasRecent && !hasIdentity && !hasProject && !sources.postCompaction && !hasReasoning && !hasConsensus && !hasGsd) {
      return { markdown: '', tokenEstimate: 0, sources: [] };
    }

    // Build sections in priority order. Each section is appended only if
    // it fits within the remaining character budget.
    const header = '# Context (auto-injected by Claudex)\n\n';
    let assembled = header;

    // Track sections that were skipped due to budget constraints
    const skipped: Array<{ section: string; source?: string }> = [];

    function tryAppend(section: string, source?: string): boolean {
      if (!section) return false;
      // Account for the newline we'll add after the section
      const withNewline = section + '\n';
      if (estimateTokens(assembled + withNewline) > config.maxTokens) {
        // Track this section as skipped for potential post-redaction reclaim
        skipped.push({ section, source });
        return false;
      }
      assembled += withNewline;
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

    // 3.5. GSD Project Phase
    if (hasGsd) {
      tryAppend(buildGsdSection(sources.gsdState!, sources.gsdPlanMustHaves, sources.gsdRequirementStatus), 'gsd');
    }

    // 4. Flow Reasoning
    if (hasReasoning) {
      tryAppend(buildReasoningSection(sources.reasoningChains!), 'reasoning');
    }

    // 5. FTS5 search results
    if (hasSearch) {
      tryAppend(buildSearchSection(sources.searchResults), 'fts5');
    }

    // 6. Recent observations (temporal context — what just happened)
    if (hasRecent) {
      tryAppend(buildRecentObservationsSection(sources.recentObservations), 'recency');
    }

    // 7. Consensus Decisions
    if (hasConsensus) {
      tryAppend(buildConsensusSection(sources.consensusDecisions!), 'consensus');
    }

    // 8. Post-compaction continuity
    if (sources.postCompaction) {
      tryAppend(buildPostCompactionSection(), 'session');
    }

    // 9. WARM files
    if (hasHologram && sources.hologram!.warm.length > 0) {
      tryAppend(buildWarmSection(sources.hologram!.warm), 'hologram');
    }

    // If only the header was added (nothing fit), return empty
    if (assembled === header) {
      return { markdown: '', tokenEstimate: 0, sources: [] };
    }

    let rawMarkdown = assembled.trimEnd() + '\n';
    // Safety-net: redact any secrets/high-entropy that slipped through ingestion
    let markdown = redactAssemblyOutput(rawMarkdown);

    // Post-redaction budget reclaim: If redaction freed up space and we have
    // skipped sections, try to append them in the order they were skipped
    // (which respects priority order)
    if (skipped.length > 0 && estimateTokens(markdown) < config.maxTokens) {
      let tempAssembled = markdown.trimEnd();

      for (const { section, source } of skipped) {
        const withNewline = '\n' + section + '\n';
        if (estimateTokens(tempAssembled + withNewline) <= config.maxTokens) {
          tempAssembled += withNewline;
          if (source && !contributedSources.includes(source)) {
            contributedSources.push(source);
          }
        }
      }

      // Re-redact in case the newly added sections contained anything sensitive
      markdown = redactAssemblyOutput(tempAssembled + '\n');
    }

    return {
      markdown,
      tokenEstimate: estimateTokens(markdown),
      sources: contributedSources,
    };
  } catch {
    return { markdown: '', tokenEstimate: 0, sources: [] };
  }
}
