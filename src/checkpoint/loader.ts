/**
 * Claudex v3 -- Checkpoint Loader (WP-5)
 *
 * Reads the most recent checkpoint YAML, applies selective loading rules,
 * and formats it for context injection. Includes the "Aider trick" where
 * thread state is formatted as user perspective for better coherence.
 *
 * Recovery chain (3-hop max, cycle-safe):
 * 1. Read latest.yaml -> parse ref: line -> load that checkpoint
 * 2. If corrupt/missing: scan checkpoints dir for newest .yaml by filename sort
 * 3. If corrupt: follow previous_checkpoint link (basename only, max 3 hops)
 * 4. If all fail: return null
 *
 * Never throws -- returns null on failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';
import type {
  Checkpoint,
  CheckpointSection,
  LoadOptions,
} from './types.js';
import {
  CHECKPOINT_SCHEMA,
  CHECKPOINT_VERSION,
  ALWAYS_LOAD,
  RESUME_LOAD,
  GSD_LOAD,
} from './types.js';

const log = createLogger('checkpoint-loader');

// =============================================================================
// Public Types
// =============================================================================

export interface LoadedCheckpoint {
  checkpoint: Checkpoint;
  loadedSections: CheckpointSection[];
  markdown: string;
  tokenEstimate: number;
  recoveryPath?: string;
}

// =============================================================================
// YAML Helpers
// =============================================================================

const MAX_RECOVERY_HOPS = 3;

/**
 * Sort checkpoint filenames numerically.
 * Handles YYYY-MM-DD_cpN.yaml where N can be any number (cp10 > cp9).
 */
function numericCheckpointSort(a: string, b: string): number {
  const extractN = (f: string): number => {
    const match = f.match(/_cp(\d+)\.yaml$/);
    return match ? parseInt(match[1]!, 10) : 0;
  };
  const dateA = a.slice(0, 10);
  const dateB = b.slice(0, 10);
  if (dateA !== dateB) return dateA.localeCompare(dateB);
  return extractN(a) - extractN(b);
}

/** Known top-level keys in a valid checkpoint */
const KNOWN_KEYS = new Set([
  'schema', 'version', 'meta', 'working', 'decisions',
  'files', 'gsd', 'open_questions', 'learnings', 'thread',
]);

/**
 * Strip UTF-8 BOM and normalize CRLF before YAML parsing.
 */
function normalizeYaml(raw: string): string {
  let content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return content;
}

/**
 * Safely parse a YAML file into an unknown value.
 * Returns null on any error.
 */
function safeLoadYamlFile(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const normalized = normalizeYaml(raw);
    return yaml.load(normalized, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    log.warn(`Failed to parse YAML: ${filePath}`, e);
    return null;
  }
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Validate a parsed object as a Checkpoint.
 * Returns the Checkpoint if valid, null otherwise.
 * Warns on unknown top-level keys but does not reject.
 */
function validateCheckpoint(data: unknown): Checkpoint | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const obj = data as Record<string, unknown>;

  // Schema + version validation
  if (obj.schema !== CHECKPOINT_SCHEMA) {
    log.warn(`Invalid checkpoint schema: ${String(obj.schema)}`);
    return null;
  }
  if (obj.version !== CHECKPOINT_VERSION) {
    log.warn(`Invalid checkpoint version: ${String(obj.version)}`);
    return null;
  }

  // Warn on unknown keys (future-proofing) but don't reject
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      log.warn(`Unknown top-level key in checkpoint: "${key}"`);
    }
  }

  // Required sections must exist and be the right shape
  if (!obj.meta || typeof obj.meta !== 'object') return null;
  if (!obj.working || typeof obj.working !== 'object') return null;
  if (!Array.isArray(obj.decisions)) return null;
  if (!obj.files || typeof obj.files !== 'object') return null;
  if (!Array.isArray(obj.open_questions)) return null;
  if (!Array.isArray(obj.learnings)) return null;
  if (!obj.thread || typeof obj.thread !== 'object') return null;

  return obj as unknown as Checkpoint;
}

// =============================================================================
// Recovery Chain
// =============================================================================

/**
 * Get the checkpoints directory for a project.
 */
function checkpointsDir(projectDir: string): string {
  return path.join(projectDir, 'context', 'checkpoints');
}

/**
 * Try to load a checkpoint from a specific file path.
 * Returns the Checkpoint if valid, null otherwise.
 */
function tryLoadCheckpointFile(filePath: string): Checkpoint | null {
  const data = safeLoadYamlFile(filePath);
  return validateCheckpoint(data);
}

/**
 * Parse latest.yaml to get the ref filename.
 * Format: "ref: {filename}.yaml"
 */
function parseLatestRef(latestPath: string): string | null {
  try {
    if (!fs.existsSync(latestPath)) return null;
    const raw = fs.readFileSync(latestPath, 'utf-8');
    const normalized = normalizeYaml(raw);
    const match = normalized.match(/^ref:\s*(.+)$/m);
    if (!match) return null;
    // Constrain to basename for safety
    return path.basename(match[1]!.trim());
  } catch {
    return null;
  }
}

/**
 * Scan checkpoints directory for .yaml files sorted newest-first by filename.
 * Excludes latest.yaml itself. Returns all candidates for iteration.
 */
function listCheckpointFiles(cpDir: string): string[] {
  try {
    if (!fs.existsSync(cpDir)) return [];
    const entries = fs.readdirSync(cpDir);
    return entries
      .filter(f => f.endsWith('.yaml') && f !== 'latest.yaml')
      .sort(numericCheckpointSort)
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Follow previous_checkpoint links, max hops, cycle-safe.
 * Returns first valid checkpoint found, or null.
 */
function followPreviousLinks(
  cpDir: string,
  startBasename: string,
  visited: Set<string>,
): { checkpoint: Checkpoint; hops: number } | null {
  let current = startBasename;
  let hops = 0;

  while (hops < MAX_RECOVERY_HOPS) {
    if (visited.has(current)) {
      log.warn(`Cycle detected in checkpoint chain at: ${current}`);
      return null;
    }
    visited.add(current);

    const filePath = path.join(cpDir, current);
    const cp = tryLoadCheckpointFile(filePath);
    if (cp) return { checkpoint: cp, hops };

    // Try to read the file just for its previous_checkpoint link
    const data = safeLoadYamlFile(filePath);
    if (!data || typeof data !== 'object') return null;

    const meta = (data as Record<string, unknown>).meta;
    if (!meta || typeof meta !== 'object') return null;

    const prevLink = (meta as Record<string, unknown>).previous_checkpoint;
    if (!prevLink || typeof prevLink !== 'string') return null;

    // Constrain to basename
    current = path.basename(prevLink);
    hops++;
  }

  log.warn(`Max recovery hops (${MAX_RECOVERY_HOPS}) exceeded`);
  return null;
}

/**
 * Execute the full recovery chain to find a valid checkpoint.
 * Returns the checkpoint and a recovery path description if fallback was used.
 */
function recoverCheckpoint(
  projectDir: string,
): { checkpoint: Checkpoint; recoveryPath?: string } | null {
  const cpDir = checkpointsDir(projectDir);
  const visited = new Set<string>();

  // Step 1: Try latest.yaml ref
  const latestPath = path.join(cpDir, 'latest.yaml');
  const refFile = parseLatestRef(latestPath);
  if (refFile) {
    const cp = tryLoadCheckpointFile(path.join(cpDir, refFile));
    if (cp) return { checkpoint: cp };
    visited.add(refFile);
  }

  // Step 2: Dir scan fallback — try all files newest-first
  const allFiles = listCheckpointFiles(cpDir);
  for (const candidate of allFiles) {
    if (visited.has(candidate)) continue;
    const cp = tryLoadCheckpointFile(path.join(cpDir, candidate));
    if (cp) return { checkpoint: cp, recoveryPath: 'dir-scan' };
    visited.add(candidate);
  }

  // Step 3: Follow previous_checkpoint links from all visited files
  const allVisited = [...visited];
  for (const startFile of allVisited) {
    const data = safeLoadYamlFile(path.join(cpDir, startFile));
    if (!data || typeof data !== 'object') continue;

    const meta = (data as Record<string, unknown>).meta;
    if (!meta || typeof meta !== 'object') continue;

    const prevLink = (meta as Record<string, unknown>).previous_checkpoint;
    if (!prevLink || typeof prevLink !== 'string') continue;

    const prevBasename = path.basename(prevLink);
    if (visited.has(prevBasename)) continue;

    const result = followPreviousLinks(cpDir, prevBasename, visited);
    if (result) {
      return {
        checkpoint: result.checkpoint,
        recoveryPath: `previous-link(${result.hops + 1}-hop)`,
      };
    }
  }

  return null;
}

// =============================================================================
// Selective Loading
// =============================================================================

/**
 * Determine which sections to load based on options and checkpoint state.
 */
function resolveSections(checkpoint: Checkpoint, options: LoadOptions): CheckpointSection[] {
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
    parts.push(`I asked you to ${checkpoint.working.task}.`);
  }

  // "You proposed [decisions[-1].what]."
  if (checkpoint.decisions.length > 0) {
    const lastDecision = checkpoint.decisions[checkpoint.decisions.length - 1]!;
    parts.push(`You proposed ${lastDecision.what}.`);

    // Check if the last exchange is an approval
    const exchanges = checkpoint.thread?.key_exchanges ?? [];
    if (exchanges.length > 0) {
      const lastExchange = exchanges[exchanges.length - 1]!;
      if (lastExchange.role === 'user') {
        parts.push(`I ${lastExchange.gist.toLowerCase()}.`);
      }
    }
  }

  // "You created [files.changed[].path]."
  if (checkpoint.files?.changed?.length > 0) {
    const paths = checkpoint.files.changed.map(f => f.path);
    if (paths.length <= 3) {
      parts.push(`You created ${paths.join(', ')}.`);
    } else {
      parts.push(`You created ${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more.`);
    }
  }

  // "Next step: [working.next_action]."
  if (checkpoint.working?.next_action) {
    parts.push(`Next step: ${checkpoint.working.next_action}.`);
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
    lines.push(`- Task: ${checkpoint.working.task}`);
    lines.push(`- Status: ${checkpoint.working.status}`);
    if (checkpoint.working.branch) {
      lines.push(`- Branch: ${checkpoint.working.branch}`);
    }
    if (checkpoint.working.next_action) {
      lines.push(`- Next: ${checkpoint.working.next_action}`);
    }
    lines.push('');
  }

  // Open questions
  if (sections.includes('open_questions') && checkpoint.open_questions.length > 0) {
    lines.push(`## Open Questions`);
    for (const q of checkpoint.open_questions) {
      lines.push(`- ${q}`);
    }
    lines.push('');
  }

  // Decisions (resume only)
  if (sections.includes('decisions') && checkpoint.decisions.length > 0) {
    lines.push(`## Decisions`);
    for (const d of checkpoint.decisions) {
      const rev = d.reversible ? ' (reversible)' : '';
      lines.push(`- **${d.what}**${rev}: ${d.why}`);
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
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  }

  // GSD state
  if (sections.includes('gsd') && checkpoint.gsd?.active) {
    lines.push(`## Project Phase (GSD)`);
    if (checkpoint.gsd.milestone) {
      lines.push(`- Milestone: ${checkpoint.gsd.milestone}`);
    }
    if (checkpoint.gsd.phase_name) {
      lines.push(`- Phase ${checkpoint.gsd.phase}: ${checkpoint.gsd.phase_name}`);
    } else {
      lines.push(`- Phase: ${checkpoint.gsd.phase}`);
    }
    if (checkpoint.gsd.phase_goal) {
      lines.push(`- Goal: ${checkpoint.gsd.phase_goal}`);
    }
    if (checkpoint.gsd.plan_status) {
      lines.push(`- Plan: ${checkpoint.gsd.plan_status}`);
    }
    if (checkpoint.gsd.requirements?.length > 0) {
      lines.push(`- Requirements:`);
      for (const r of checkpoint.gsd.requirements) {
        lines.push(`  - ${r.id} [${r.status}]: ${r.description}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// =============================================================================
// Token Estimation
// =============================================================================

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Load the latest checkpoint for a project.
 *
 * Applies the recovery chain (latest.yaml -> dir scan -> previous links).
 * Selectively loads sections based on options.
 * Formats output as markdown for context injection.
 *
 * Never throws -- returns null on failure.
 */
export function loadLatestCheckpoint(
  projectDir: string,
  options?: LoadOptions,
): LoadedCheckpoint | null {
  const t0 = Date.now();
  let recoveryTag: string | undefined;

  try {
    const effectiveOptions: LoadOptions = options ?? {
      sections: [],
      resumeMode: false,
    };

    const result = recoverCheckpoint(projectDir);
    if (!result) {
      log.info('No valid checkpoint found');
      return null;
    }

    recoveryTag = result.recoveryPath;
    const { checkpoint } = result;
    const loadedSections = resolveSections(checkpoint, effectiveOptions);
    const markdown = formatCheckpointForInjection(checkpoint, effectiveOptions);
    const tokenEstimate = estimateTokens(markdown);

    return {
      checkpoint,
      loadedSections,
      markdown,
      tokenEstimate,
      recoveryPath: result.recoveryPath,
    };
  } catch (e) {
    log.error('loadLatestCheckpoint failed', e);
    return null;
  } finally {
    const duration = Date.now() - t0;
    recordMetric('checkpoint_load', duration, !!recoveryTag);
  }
}
