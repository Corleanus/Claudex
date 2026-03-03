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
} from '../shared/types.js';
import { redactAssemblyOutput } from './redaction.js';
import {
  estimateTokens,
  buildIdentitySection,
  buildProjectSection,
  buildHotSection,
  buildGsdSection,
  buildSearchSection,
  buildReasoningSection,
  buildConsensusSection,
  buildPostCompactionSection,
  buildWarmSection,
  buildRecentObservationsSection,
  buildUnifiedResumeSection,
  buildSearchSectionRef,
  buildRecentSectionRef,
  buildReasoningSectionRef,
  buildConsensusSectionRef,
  buildWarmSectionRef,
} from './context-sections.js';

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
    const hasCheckpointGsd = !!(sources.checkpointGsd?.active);

    if (!hasHologram && !hasSearch && !hasRecent && !hasIdentity && !hasProject && !sources.postCompaction && !hasReasoning && !hasConsensus && !hasGsd && !hasCheckpointGsd) {
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

    // Unified post-compact GSD restoration path
    // When postCompaction + GSD available, render a single merged section
    // that replaces individual GSD + HOT + WARM + Session Continuity sections
    const useUnifiedPath = sources.postCompaction && (hasGsd || hasCheckpointGsd);

    if (useUnifiedPath) {
      const hotFiles = sources.hologram?.hot ?? [];
      const warmFiles = sources.hologram?.warm ?? [];
      const unified = buildUnifiedResumeSection(
        sources.gsdState,
        sources.checkpointGsd,
        hotFiles,
        warmFiles,
      );

      if (unified) {
        // 1. Identity + Project (same as normal)
        if (hasIdentity) tryAppend(buildIdentitySection(sources), 'identity');
        if (hasProject) tryAppend(buildProjectSection(sources), 'project');

        // 2. Unified resume section (replaces GSD + HOT + WARM + Session Continuity)
        tryAppend(unified, 'gsd');
        if (hotFiles.length > 0 && !contributedSources.includes('hologram')) {
          contributedSources.push('hologram');
        }
        if (!contributedSources.includes('session')) {
          contributedSources.push('session');
        }

        // 3. Remaining non-replaced sections
        const remainingTokensU = config.maxTokens - estimateTokens(assembled);
        const useReferencesU = remainingTokensU < 500;

        if (hasReasoning) {
          const builder = useReferencesU ? buildReasoningSectionRef : buildReasoningSection;
          tryAppend(builder(sources.reasoningChains!), 'reasoning');
        }
        if (hasSearch) {
          const builder = useReferencesU ? buildSearchSectionRef : buildSearchSection;
          tryAppend(builder(sources.searchResults), 'fts5');
        }
        if (hasRecent) {
          const builder = useReferencesU ? buildRecentSectionRef : buildRecentObservationsSection;
          tryAppend(builder(sources.recentObservations), 'recency');
        }
        if (hasConsensus) {
          const builder = useReferencesU ? buildConsensusSectionRef : buildConsensusSection;
          tryAppend(builder(sources.consensusDecisions!), 'consensus');
        }
        // HOT, WARM, Session Continuity are folded into unified — skip them
      }
    }

    // Standard path (non-post-compact, or no GSD available for unified section)
    if (!useUnifiedPath) {
      // 1. Identity (lightweight, always fits)
      if (hasIdentity) {
        tryAppend(buildIdentitySection(sources), 'identity');
      }

      // 2. Project context
      if (hasProject) {
        tryAppend(buildProjectSection(sources), 'project');
      }

      // 3. HOT files
      const hologram = sources.hologram;
      if (hasHologram && hologram && hologram.hot.length > 0) {
        tryAppend(buildHotSection(hologram.hot), 'hologram');
      }

      // 3.5. GSD Project Phase
      if (hasGsd) {
        tryAppend(buildGsdSection(sources.gsdState!, sources.gsdPlanMustHaves, sources.gsdRequirementStatus), 'gsd');
      }

      // Compute remaining budget after priority sections (1-3.5)
      const remainingTokens = config.maxTokens - estimateTokens(assembled);
      const useReferences = remainingTokens < 500;

      // 4. Flow Reasoning
      if (hasReasoning) {
        const builder = useReferences ? buildReasoningSectionRef : buildReasoningSection;
        tryAppend(builder(sources.reasoningChains!), 'reasoning');
      }

      // 5. FTS5 search results
      if (hasSearch) {
        const builder = useReferences ? buildSearchSectionRef : buildSearchSection;
        tryAppend(builder(sources.searchResults), 'fts5');
      }

      // 6. Recent observations (temporal context — what just happened)
      if (hasRecent) {
        const builder = useReferences ? buildRecentSectionRef : buildRecentObservationsSection;
        tryAppend(builder(sources.recentObservations), 'recency');
      }

      // 7. Consensus Decisions
      if (hasConsensus) {
        const builder = useReferences ? buildConsensusSectionRef : buildConsensusSection;
        tryAppend(builder(sources.consensusDecisions!), 'consensus');
      }

      // 8. Post-compaction continuity — ALWAYS inline, never reference mode
      if (sources.postCompaction) {
        tryAppend(buildPostCompactionSection(), 'session');
      }

      // 9. WARM files
      if (hasHologram && hologram && hologram.warm.length > 0) {
        const builder = useReferences ? buildWarmSectionRef : buildWarmSection;
        tryAppend(builder(hologram.warm), 'hologram');
      }
    }

    // 9.5. Search result reservation: ensure FTS5 results get at least a ref slot
    // If search was skipped due to budget but search results exist, trim the
    // lowest-priority added section to make room for a compact search reference.
    if (hasSearch && !contributedSources.includes('fts5')) {
      const SEARCH_RESERVE = 500;
      const searchRef = buildSearchSectionRef(sources.searchResults);
      const searchRefTokens = estimateTokens(searchRef + '\n');

      if (searchRefTokens <= SEARCH_RESERVE) {
        // Try to trim lowest-priority sections (reverse priority) to free space
        // Use prefix matching to handle both full and ref variants (e.g., "## Warm Context" and "## Warm Context (refs)")
        const trimmablePrefixes = ['## Warm Context', '## Session Continuity', '## Consensus Decisions', '## Recent Activity'];
        for (const prefix of trimmablePrefixes) {
          const idx = assembled.indexOf(prefix);
          if (idx === -1) continue;

          // Find the end of this section (next ## header or end of string)
          const nextHeader = assembled.indexOf('\n## ', idx + 1);
          const sectionEnd = nextHeader === -1 ? assembled.length : nextHeader;
          const trimmed = assembled.slice(0, idx) + assembled.slice(sectionEnd);

          if (estimateTokens(trimmed + searchRef + '\n') <= config.maxTokens) {
            assembled = trimmed + searchRef + '\n';
            if (!contributedSources.includes('fts5')) {
              contributedSources.push('fts5');
            }
            break;
          }
        }
      }
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
      // Track which sources have already been appended (prevents duplication)
      const appendedSources = new Set(contributedSources);

      for (const { section, source } of skipped) {
        // Skip if this source was already appended
        if (source && appendedSources.has(source)) continue;

        const withNewline = '\n' + section + '\n';
        if (estimateTokens(tempAssembled + withNewline) <= config.maxTokens) {
          tempAssembled += withNewline;
          if (source) {
            appendedSources.add(source);
            if (!contributedSources.includes(source)) {
              contributedSources.push(source);
            }
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
