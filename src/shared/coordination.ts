/**
 * Claudex v2 — Coordination Config Reader
 *
 * Reads ~/.echo/coordination.json to coordinate with the Context Manager
 * when both systems are active. Returns standalone defaults if file is missing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CoordinationConfig {
  version: number;
  checkpoint_primary: 'claudex' | 'context_manager';
  injection_budget: {
    claudex: number;
    context_manager: number;
    total: number;
  };
  post_compact_restore: 'claudex' | 'context_manager';
  tool_tracking: 'claudex' | 'context_manager' | 'both';
  thread_tracking: 'claudex' | 'context_manager';
  learnings: 'claudex' | 'context_manager';
  gauge_display: 'claudex' | 'context_manager';
}

/** Standalone defaults — Claudex owns everything with full budget */
const STANDALONE_DEFAULTS: CoordinationConfig = {
  version: 1,
  checkpoint_primary: 'claudex',
  injection_budget: {
    claudex: 4000,
    context_manager: 0,
    total: 4000,
  },
  post_compact_restore: 'claudex',
  tool_tracking: 'claudex',
  thread_tracking: 'claudex',
  learnings: 'claudex',
  gauge_display: 'claudex',
};

const COORDINATION_PATH = path.join(os.homedir(), '.echo', 'coordination.json');

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_OWNERS = new Set<'claudex' | 'context_manager'>(['claudex', 'context_manager']);
const VALID_TOOL_TRACKING = new Set<'claudex' | 'context_manager' | 'both'>(['claudex', 'context_manager', 'both']);

function validateEnum<T extends string>(value: unknown, valid: Set<T>, fallback: T): T {
  return typeof value === 'string' && valid.has(value as T) ? value as T : fallback;
}

function validatePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Read coordination config from ~/.echo/coordination.json.
 * Deep-validates every field against STANDALONE_DEFAULTS — tampered or
 * missing fields fall back to safe defaults.
 */
export function readCoordinationConfig(): CoordinationConfig {
  try {
    if (!fs.existsSync(COORDINATION_PATH)) {
      return structuredClone(STANDALONE_DEFAULTS);
    }
    const raw = fs.readFileSync(COORDINATION_PATH, 'utf-8');
    const parsed = JSON.parse(raw);

    return {
      version: typeof parsed.version === 'number' ? parsed.version : STANDALONE_DEFAULTS.version,
      checkpoint_primary: validateEnum(parsed.checkpoint_primary, VALID_OWNERS, STANDALONE_DEFAULTS.checkpoint_primary),
      injection_budget: {
        claudex: validatePositiveNumber(parsed.injection_budget?.claudex, STANDALONE_DEFAULTS.injection_budget.claudex),
        context_manager: validatePositiveNumber(parsed.injection_budget?.context_manager, STANDALONE_DEFAULTS.injection_budget.context_manager),
        total: validatePositiveNumber(parsed.injection_budget?.total, STANDALONE_DEFAULTS.injection_budget.total),
      },
      post_compact_restore: validateEnum(parsed.post_compact_restore, VALID_OWNERS, STANDALONE_DEFAULTS.post_compact_restore),
      tool_tracking: validateEnum(parsed.tool_tracking, VALID_TOOL_TRACKING, STANDALONE_DEFAULTS.tool_tracking),
      thread_tracking: validateEnum(parsed.thread_tracking, VALID_OWNERS, STANDALONE_DEFAULTS.thread_tracking),
      learnings: validateEnum(parsed.learnings, VALID_OWNERS, STANDALONE_DEFAULTS.learnings),
      gauge_display: validateEnum(parsed.gauge_display, VALID_OWNERS, STANDALONE_DEFAULTS.gauge_display),
    };
  } catch {
    return structuredClone(STANDALONE_DEFAULTS);
  }
}
