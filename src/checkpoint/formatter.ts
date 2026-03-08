/**
 * Claudex v3 -- Checkpoint Formatter
 *
 * Formats checkpoint data into markdown for context injection.
 * Includes the "Aider trick" where thread state is formatted as user
 * perspective for better coherence.
 *
 * Extracted from loader.ts to separate formatting from recovery logic.
 */

import type {
  Checkpoint,
  CheckpointSection,
  LoadOptions,
} from './types.js';
import {
  ALWAYS_LOAD,
  RESUME_LOAD,
  GSD_LOAD,
} from './types.js';
import { escapeUntrustedText } from '../lib/context-sections.js';

// =============================================================================
// Selective Loading
// =============================================================================

/**
 * Determine which sections to load based on options and checkpoint state.
 */
export function resolveSections(checkpoint: Checkpoint, options: LoadOptions): CheckpointSection[] {
  const sections = new Set<CheckpointSection>(ALWAYS_LOAD);

  if (options.resumeMode) {
    for (const s of RESUME_LOAD) {
      sections.add(s);
    }
  }

  // GSD section: only when gsd is active
  if (checkpoint.gsd?.active) {
    for (const s of GSD_LOAD) {
      sections.add(s);
    }
  }

  // Learnings are NEVER loaded (routed to memory system)
  sections.delete('learnings');

  // Also filter by explicitly requested sections if provided
  if (options.sections.length > 0) {
    const requested = new Set(options.sections);
    for (const s of [...sections]) {
      if (!requested.has(s)) {
        sections.delete(s);
      }
    }
    // Never include learnings regardless
    sections.delete('learnings');
  }

  return [...sections];
}

// =============================================================================
// Markdown Formatting
// =============================================================================

/**
 * Format the "Aider trick" — thread state as user perspective.
 */
function formatAiderTrick(checkpoint: Checkpoint): string {
  const parts: string[] = [];

  // "I asked you to [working.task]."
  if (checkpoint.working?.task) {
    parts.push(`I asked you to ${escapeUntrustedText(checkpoint.working.task, 300)}.`);
  }

  // "You proposed [decisions[-1].what]."
  if (checkpoint.decisions.length > 0) {
    const lastDecision = checkpoint.decisions[checkpoint.decisions.length - 1];
    if (lastDecision && typeof lastDecision.what === 'string') {
      parts.push(`You proposed ${escapeUntrustedText(lastDecision.what, 300)}.`);
    }

    // Check if the last exchange is an approval
    const exchanges = checkpoint.thread?.key_exchanges;
    if (Array.isArray(exchanges) && exchanges.length > 0) {
      const lastExchange = exchanges[exchanges.length - 1];
      if (lastExchange && lastExchange.role === 'user' && typeof lastExchange.gist === 'string') {
        parts.push(`I ${escapeUntrustedText(lastExchange.gist.toLowerCase(), 200)}.`);
      }
    }
  }

  // Group files by action verb (O02: use action-appropriate verb, not always "created")
  if (Array.isArray(checkpoint.files?.changed) && checkpoint.files.changed.length > 0) {
    const verbMap: Record<string, string> = { Write: 'created', Edit: 'edited' };
    const grouped = new Map<string, string[]>();
    for (const f of checkpoint.files.changed) {
      if (!f || typeof f.path !== 'string') continue;
      const verb = verbMap[f.action] ?? 'modified';
      if (!grouped.has(verb)) grouped.set(verb, []);
      grouped.get(verb)!.push(escapeUntrustedText(f.path, 200));
    }
    for (const [verb, paths] of grouped) {
      if (paths.length <= 3) {
        parts.push(`You ${verb} ${paths.join(', ')}.`);
      } else {
        parts.push(`You ${verb} ${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more.`);
      }
    }
  }

  // "Next step: [working.next_action]."
  if (checkpoint.working?.next_action) {
    parts.push(`Next step: ${escapeUntrustedText(checkpoint.working.next_action, 300)}.`);
  }

  return parts.join(' ');
}

/**
 * Format a checkpoint into markdown for context injection.
 */
export function formatCheckpointForInjection(
  checkpoint: Checkpoint,
  options: LoadOptions,
): string {
  const sections = resolveSections(checkpoint, options);
  const lines: string[] = ['# Checkpoint (auto-injected by Claudex)', ''];

  // Meta — gauge only
  if (sections.includes('meta') && checkpoint.meta?.token_usage) {
    const usage = checkpoint.meta.token_usage;
    const pct = Math.round(usage.utilization * 100);
    lines.push(`## Token Gauge`);
    lines.push(`- Utilization: ${pct}% (${usage.input_tokens.toLocaleString()} / ${usage.window_size.toLocaleString()})`);
    lines.push('');
  }

  // Working state
  if (sections.includes('working') && checkpoint.working) {
    lines.push(`## Working State`);
    lines.push(`- Task: ${escapeUntrustedText(checkpoint.working.task, 300)}`);
    lines.push(`- Status: ${escapeUntrustedText(checkpoint.working.status, 50)}`);
    if (checkpoint.working.branch) {
      lines.push(`- Branch: ${escapeUntrustedText(checkpoint.working.branch, 200)}`);
    }
    if (checkpoint.working.next_action) {
      lines.push(`- Next: ${escapeUntrustedText(checkpoint.working.next_action, 300)}`);
    }
    lines.push('');
  }

  // Open questions
  if (sections.includes('open_questions') && checkpoint.open_questions.length > 0) {
    lines.push(`## Open Questions`);
    for (const q of checkpoint.open_questions) {
      lines.push(`- ${escapeUntrustedText(q, 300)}`);
    }
    lines.push('');
  }

  // Decisions (resume only)
  if (sections.includes('decisions') && checkpoint.decisions.length > 0) {
    lines.push(`## Decisions`);
    for (const d of checkpoint.decisions) {
      const rev = d.reversible ? ' (reversible)' : '';
      lines.push(`- **${escapeUntrustedText(d.what, 200)}**${rev}: ${escapeUntrustedText(d.why, 300)}`);
    }
    lines.push('');
  }

  // Thread (resume only) — uses Aider trick
  if (sections.includes('thread') && checkpoint.thread) {
    const aider = formatAiderTrick(checkpoint);
    if (aider) {
      lines.push(`## Thread Continuity`);
      lines.push(aider);
      lines.push('');
    }
  }

  // Files hot (resume only)
  if (sections.includes('files') && checkpoint.files?.hot?.length > 0) {
    lines.push(`## Active Files`);
    for (const f of checkpoint.files.hot) {
      lines.push(`- \`${escapeUntrustedText(f, 200)}\``);
    }
    lines.push('');
  }

  // GSD state
  if (sections.includes('gsd') && checkpoint.gsd?.active) {
    lines.push(`## Project Phase (GSD)`);
    if (checkpoint.gsd.milestone) {
      lines.push(`- Milestone: ${escapeUntrustedText(checkpoint.gsd.milestone, 200)}`);
    }
    if (checkpoint.gsd.phase_name) {
      lines.push(`- Phase ${checkpoint.gsd.phase}: ${escapeUntrustedText(checkpoint.gsd.phase_name, 200)}`);
    } else {
      lines.push(`- Phase: ${checkpoint.gsd.phase}`);
    }
    if (checkpoint.gsd.phase_goal) {
      lines.push(`- Goal: ${escapeUntrustedText(checkpoint.gsd.phase_goal, 300)}`);
    }
    if (checkpoint.gsd.plan_status) {
      lines.push(`- Plan: ${escapeUntrustedText(checkpoint.gsd.plan_status, 200)}`);
    }
    if (checkpoint.gsd.requirements?.length > 0) {
      lines.push(`- Requirements:`);
      for (const r of checkpoint.gsd.requirements) {
        lines.push(`  - ${escapeUntrustedText(r.id, 50)} [${escapeUntrustedText(r.status, 50)}]: ${escapeUntrustedText(r.description, 300)}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}
