/**
 * Claudex v2 — Context Section Builders
 *
 * Pure string-formatting functions that build individual markdown sections
 * for the context assembler. Each function takes structured data and returns
 * a markdown string (or empty string if no data).
 *
 * Extracted from context-assembler.ts to separate section rendering from
 * assembly/budget logic.
 */

import type {
  ContextSources,
  ScoredFile,
  Observation,
  SearchResult,
  ReasoningChain,
  ConsensusDecision,
} from '../shared/types.js';
import type { GsdState } from '../gsd/types.js';
import type { GsdCheckpointState } from '../checkpoint/types.js';

// =============================================================================
// Token estimation
// =============================================================================

export function estimateTokens(text: string): number {
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
// Untrusted text escaping
// =============================================================================

/**
 * Escape untrusted text before rendering into prompt context.
 * Prevents markdown injection and caps length.
 *
 * - Replaces leading '#' chars (heading injection)
 * - Replaces '---' at line start (frontmatter injection)
 * - Neutralizes HTML-like angle brackets
 * - Caps at maxLength chars with '...' truncation
 */
export function escapeUntrustedText(text: string, maxLength = 200): string {
  if (!text) return '';
  let escaped = text.slice(0, maxLength);
  if (text.length > maxLength) escaped += '...';
  // Neutralize markdown heading injection: replace leading # with Unicode fullwidth #
  escaped = escaped.replace(/^(#{1,6})\s/gm, (_, hashes: string) => '\uFF03'.repeat(hashes.length) + ' ');
  // Neutralize horizontal rule / frontmatter delimiter
  escaped = escaped.replace(/^---+$/gm, '\u2014\u2014\u2014');
  // Neutralize HTML tags that might affect rendering
  escaped = escaped.replace(/</g, '\uFF1C').replace(/>/g, '\uFF1E');
  return escaped;
}

// =============================================================================
// Section builders
// =============================================================================

export function buildIdentitySection(sources: ContextSources): string {
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

export function buildProjectSection(sources: ContextSources): string {
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

export function buildHotSection(hotFiles: ScoredFile[]): string {
  if (hotFiles.length === 0) return '';
  const lines = hotFiles.map(f => {
    const boost = f.phase_boosted ? ' [phase]' : '';
    return `- \`${f.path}\` — HOT (pressure: ${f.raw_pressure.toFixed(2)})${boost}`;
  });
  return `## Active Focus\n${lines.join('\n')}\n`;
}

export function buildGsdSection(
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

export function buildSearchSection(results: SearchResult[]): string {
  if (results.length === 0) return '';
  const lines = results.map(r => {
    const ago = formatTimeAgo(r.observation.timestamp_epoch);
    const cat = r.observation.category.charAt(0).toUpperCase() + r.observation.category.slice(1);
    return `- [${ago}] ${cat}: ${escapeUntrustedText(r.observation.title)}`;
  });
  return `## Related Observations\n${lines.join('\n')}\n`;
}

export function buildReasoningSection(chains: ReasoningChain[]): string {
  if (chains.length === 0) return '';
  const lines = chains.map(c => {
    const ago = formatTimeAgo(c.timestamp_epoch);
    const escapedTitle = escapeUntrustedText(c.title, 100);
    const truncated =
      c.reasoning.length > 500 ? c.reasoning.slice(0, 500) + '...' : c.reasoning;
    return `### ${escapedTitle} (${ago})\n\`\`\`\n${truncated}\n\`\`\`\n`;
  });
  return `## Flow Reasoning\n${lines.join('\n')}\n`;
}

export function buildConsensusSection(decisions: ConsensusDecision[]): string {
  if (decisions.length === 0) return '';
  const lines = decisions.map(d => {
    const ago = formatTimeAgo(d.timestamp_epoch);
    const escapedTitle = escapeUntrustedText(d.title, 100);
    const truncated =
      d.description.length > 300 ? d.description.slice(0, 300) + '...' : d.description;
    return `### ${escapedTitle} [${d.status}] (${ago})\n${escapeUntrustedText(truncated, 300)}\n`;
  });
  return `## Consensus Decisions\n${lines.join('\n')}\n`;
}

export function buildPostCompactionSection(): string {
  return `## Session Continuity\n- Context was recently compacted. Prior conversation state has been summarized.\n`;
}

export function buildRecentObservationsSection(observations: Observation[]): string {
  if (observations.length === 0) return '';
  const lines = observations.map(o => {
    const ago = formatTimeAgo(o.timestamp_epoch);
    const cat = o.category.charAt(0).toUpperCase() + o.category.slice(1);
    return `- [${ago}] ${cat}: ${escapeUntrustedText(o.title)}`;
  });
  return `## Recent Activity\n${lines.join('\n')}\n`;
}

// =============================================================================
// Unified resume section (post-compact GSD restoration)
// =============================================================================

export function buildUnifiedResumeSection(
  gsdState: GsdState | undefined,
  checkpointGsd: GsdCheckpointState | undefined,
  hotFiles: ScoredFile[],
  warmFiles: ScoredFile[],
): string {
  // Determine GSD source: live preferred, checkpoint fallback
  let phaseNum: number;
  let phaseName: string;
  let phaseGoal: string | null = null;
  let pct: number;
  let planStatus: string | null = null;

  if (gsdState?.active && gsdState.position) {
    phaseNum = gsdState.position.phase;
    const currentPhase = gsdState.phases.find(p => p.number === phaseNum);
    phaseName = gsdState.position.phaseName ?? currentPhase?.name ?? 'Unknown';
    phaseGoal = currentPhase?.goal ?? null;

    const completedCount = gsdState.phases.filter(p => p.roadmapComplete).length;
    const totalCount = gsdState.position.totalPhases;
    pct = totalCount > 0 ? Math.round(completedCount / totalCount * 100) : 0;

    if (gsdState.position.totalPlans != null) {
      planStatus = `${gsdState.position.plan} of ${gsdState.position.totalPlans}`;
    }
  } else if (checkpointGsd?.active) {
    phaseNum = checkpointGsd.phase;
    phaseName = checkpointGsd.phase_name ?? 'Unknown';
    phaseGoal = checkpointGsd.phase_goal ?? null;
    pct = checkpointGsd.completion_pct;
    planStatus = checkpointGsd.plan_status ?? null;
  } else {
    return '';
  }

  const lines: string[] = [];
  lines.push(`## Resuming: Phase ${phaseNum} — ${phaseName}`);
  lines.push(`- Progress: ${pct}%`);

  if (phaseGoal) {
    lines.push(`- Goal: ${phaseGoal}`);
  }

  if (planStatus) {
    lines.push(`- Plan: ${planStatus}`);
  }

  // HOT files (up to 5)
  if (hotFiles.length > 0) {
    const hotEntries = hotFiles.slice(0, 5).map(f =>
      `\`${f.path}\` (HOT ${f.raw_pressure.toFixed(2)})`
    ).join(', ');
    lines.push(`- Active files: ${hotEntries}`);
  }

  // WARM files (up to 5)
  if (warmFiles.length > 0) {
    const warmEntries = warmFiles.slice(0, 5).map(f => `\`${f.path}\``).join(', ');
    lines.push(`- Warm: ${warmEntries}`);
  }

  lines.push('- Context was compacted. Prior conversation has been summarized.');

  return lines.join('\n') + '\n';
}

// =============================================================================
// Reference builders (compact mode — emitted when token budget is tight)
// =============================================================================

export function buildSearchSectionRef(results: SearchResult[]): string {
  if (results.length === 0) return '';
  const top = results[0]!;
  const ago = formatTimeAgo(top.observation.timestamp_epoch);
  return `## Related Observations (refs)\n- [${results.length} observations, top: "${escapeUntrustedText(top.observation.title, 100)}" (${ago})]\n`;
}

export function buildRecentSectionRef(observations: Observation[]): string {
  if (observations.length === 0) return '';
  const latest = observations[0]!;
  const ago = formatTimeAgo(latest.timestamp_epoch);
  return `## Recent Activity (refs)\n- [${observations.length} observations, latest: "${escapeUntrustedText(latest.title, 100)}" (${ago})]\n`;
}

export function buildReasoningSectionRef(chains: ReasoningChain[]): string {
  if (chains.length === 0) return '';
  const latest = chains[0]!;
  const ago = formatTimeAgo(latest.timestamp_epoch);
  return `## Flow Reasoning (refs)\n- [${chains.length} chains, latest: "${escapeUntrustedText(latest.title, 100)}" (${ago})]\n`;
}

export function buildConsensusSectionRef(decisions: ConsensusDecision[]): string {
  if (decisions.length === 0) return '';
  const latest = decisions[0]!;
  const ago = formatTimeAgo(latest.timestamp_epoch);
  return `## Consensus Decisions (refs)\n- [${decisions.length} decisions, latest: "${escapeUntrustedText(latest.title, 100)}" [${latest.status}] (${ago})]\n`;
}

