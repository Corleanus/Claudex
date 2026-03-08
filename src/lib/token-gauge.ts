/**
 * Claudex v3 — Token Gauge (WP-1)
 *
 * Reads Claude Code's transcript JSONL to extract exact context window
 * utilization from API response metadata. Foundation for the checkpoint
 * system — tells UserPromptSubmit when context hits 75%.
 *
 * NEVER throws. Always returns a GaugeReading.
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { recordMetric } from '../shared/metrics.js';

// =============================================================================
// Types
// =============================================================================

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

type GaugeThreshold = 'normal' | 'approaching' | 'checkpoint' | 'critical' | 'unavailable';

export interface GaugeReading {
  status: 'ok' | 'unavailable';
  usage: TokenUsage;
  window_size: number;
  utilization: number;
  formatted: string;
  threshold: GaugeThreshold;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_WINDOW_SIZE = 200_000;
const GAUGE_BAR_WIDTH = 10;
const BOM = '\uFEFF';

/**
 * Models known to support 1M context windows.
 * Used for heuristic detection: model must be capable AND observed tokens > 195k.
 */
const MODELS_1M_CAPABLE: string[] = [
  'claude-opus-4',
  'claude-sonnet-4',
];

const WINDOW_1M = 1_000_000;

/** Maximum transcript file size we'll read. Files larger than this are rejected. */
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** We only need the tail of the transcript — recent API responses contain the latest usage. */
const MAX_TAIL_BYTES = 100 * 1024; // 100 KB

function is1MCapableModel(model: string): boolean {
  return MODELS_1M_CAPABLE.some(prefix => model.startsWith(prefix));
}

/**
 * Compute incremental checkpoint thresholds for a given window size.
 * 200k: 2 checkpoints (75%, 90%) — minimal overhead, similar to old behavior.
 * >200k: 6 checkpoints (15%, 30%, 45%, 60%, 75%, 90%) — full incremental coverage.
 */
export function getIncrementalThresholds(windowSize: number): number[] {
  const percentages = windowSize > DEFAULT_WINDOW_SIZE
    ? [0.15, 0.30, 0.45, 0.60, 0.75, 0.90]   // 1M: full coverage
    : [0.75, 0.90];                              // 200k: light touch
  return percentages.map(pct => Math.round(windowSize * pct));
}

/**
 * @deprecated Use getIncrementalThresholds(windowSize) instead.
 * Kept for backwards compatibility — now returns 200k thresholds (2 entries).
 */
export const INCREMENTAL_THRESHOLDS = getIncrementalThresholds(DEFAULT_WINDOW_SIZE);

const ZERO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
};

const UNAVAILABLE_READING: GaugeReading = {
  status: 'unavailable',
  usage: { ...ZERO_USAGE },
  window_size: DEFAULT_WINDOW_SIZE,
  utilization: 0,
  formatted: '[Token gauge unavailable]',
  threshold: 'unavailable',
};

// =============================================================================
// Threshold Logic
// =============================================================================

function classifyThreshold(utilization: number): GaugeThreshold {
  if (utilization >= 0.95) return 'critical';
  if (utilization >= 0.75) return 'checkpoint';
  if (utilization >= 0.65) return 'approaching';
  return 'normal';
}

// =============================================================================
// Gauge Bar Formatting
// =============================================================================

/**
 * Format a visual gauge bar with utilization percentage and token counts.
 *
 * Example: "[████████░░ 81% | 162k/200k]"
 */
export function formatGauge(utilization: number, inputTokens: number, windowSize: number): string {
  const pct = Math.round(utilization * 100);
  const clampedUtil = Math.min(Math.max(utilization, 0), 1);
  const filled = Math.round(clampedUtil * GAUGE_BAR_WIDTH);
  const empty = GAUGE_BAR_WIDTH - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  const formatK = (n: number): string => {
    if (n >= 1000) return `${Math.round(n / 1000)}k`;
    return String(n);
  };

  return `[${bar} ${pct}% | ${formatK(inputTokens)}/${formatK(windowSize)}]`;
}

// =============================================================================
// Path Validation & Tail Reading
// =============================================================================

/**
 * Validate that a transcript path is safe to read.
 * Must end with .jsonl and resolve under a directory containing .claude or AppData.
 */
function isValidTranscriptPath(transcriptPath: string): boolean {
  // Must be a .jsonl file
  if (!transcriptPath.endsWith('.jsonl')) return false;

  // Resolve to absolute and normalize separators for cross-platform check
  const resolved = nodePath.resolve(transcriptPath).replace(/\\/g, '/');
  // Transcript files live under .claude/ or AppData/ directories
  if (resolved.includes('/.claude/') || resolved.includes('/AppData/')) return true;

  // Also accept temp directories (used by tests)
  const tmpDir = (process.env.TMPDIR || process.env.TEMP || process.env.TMP || '/tmp').replace(/\\/g, '/');
  if (resolved.startsWith(tmpDir)) return true;

  return false;
}

/**
 * Read only the tail of a file (last MAX_TAIL_BYTES). Returns the content string.
 * If the file is smaller than MAX_TAIL_BYTES, reads the whole file.
 * Discards the first (potentially partial) line when reading a tail slice.
 */
function readTailContent(transcriptPath: string, fileSize: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const readSize = Math.min(fileSize, MAX_TAIL_BYTES);
    const start = Math.max(0, fileSize - readSize);
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, start);
    let content = buffer.toString('utf-8');

    // If we didn't read from the beginning, the first line is likely partial — discard it
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline !== -1) {
        content = content.slice(firstNewline + 1);
      }
      // If there's no newline at all in 100KB, the data is one giant line — unusable
    }

    return content;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// =============================================================================
// JSONL Parsing (backwards scan)
// =============================================================================

/**
 * Scan transcript JSONL backwards and extract data from the last assistant message.
 * Single read, returns both model name and usage.
 * Handles: partial/malformed trailing lines, CRLF, BOM.
 */
function extractLastAssistantData(content: string): { model: string | null; usage: TokenUsage | null } {
  let text = content;
  if (text.startsWith(BOM)) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);

  let model: string | null = null;
  let usage: TokenUsage | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]!);
      const msg = parsed?.message;
      if (!msg) continue;

      // Capture model from first assistant message found
      if (!model && msg.model && typeof msg.model === 'string') {
        model = msg.model;
      }

      // Capture usage from first message with input_tokens
      if (!usage && msg.usage && typeof msg.usage.input_tokens === 'number') {
        usage = {
          input_tokens: msg.usage.input_tokens,
          output_tokens: typeof msg.usage.output_tokens === 'number' ? msg.usage.output_tokens : 0,
          cache_creation_input_tokens: typeof msg.usage.cache_creation_input_tokens === 'number' ? msg.usage.cache_creation_input_tokens : 0,
          cache_read_input_tokens: typeof msg.usage.cache_read_input_tokens === 'number' ? msg.usage.cache_read_input_tokens : 0,
        };
      }

      // Both found — done
      if (model && usage) break;
    } catch {
      // Malformed line — skip and try next
      continue;
    }
  }

  return { model, usage };
}

/** Thin wrapper for backward compat — delegates to extractLastAssistantData. */
function extractLastUsage(content: string): TokenUsage | null {
  return extractLastAssistantData(content).usage;
}

// =============================================================================
// Window Size Detection
// =============================================================================

/**
 * Detect context window size. Conservative: always returns 200k unless config override.
 *
 * Model-based detection was removed because knowing a model is 1M-capable
 * doesn't mean the session has 1M activated. Use readTokenGaugeWithDetection()
 * for heuristic 1M detection based on observed token counts.
 *
 * @param _transcriptPath - Path to the transcript JSONL (unused, kept for API compat)
 * @param configOverride - Explicit window size from ~/.claudex/config.json
 * @returns Detected window size in tokens
 */
export function detectWindowSize(_transcriptPath: string | undefined, configOverride?: number): number {
  if (configOverride && configOverride > 0) return configOverride;
  return DEFAULT_WINDOW_SIZE;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Read token utilization from a Claude Code transcript JSONL file.
 *
 * @param transcriptPath - Path to the transcript JSONL file. If undefined/empty, returns unavailable.
 * @param windowSize - Context window size in tokens. Defaults to 200,000.
 * @returns GaugeReading — never throws.
 */
export function readTokenGauge(transcriptPath: string | undefined, windowSize?: number): GaugeReading {
  const start = Date.now();
  const ws = windowSize ?? DEFAULT_WINDOW_SIZE;

  try {
    // Guard: missing/empty transcript path
    if (!transcriptPath) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Guard: path validation (must be .jsonl under expected directory)
    if (!isValidTranscriptPath(transcriptPath)) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Guard: file doesn't exist
    if (!fs.existsSync(transcriptPath)) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Guard: empty file or oversized file
    let stat: fs.Stats;
    try {
      stat = fs.statSync(transcriptPath);
    } catch {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    if (stat.size === 0 || stat.size > MAX_FILE_SIZE) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Read only the tail of the file — usage data is in recent entries
    const content = readTailContent(transcriptPath, stat.size);
    if (!content) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Extract usage from last assistant message
    const usage = extractLastUsage(content);
    if (!usage) {
      return { ...UNAVAILABLE_READING, window_size: ws };
    }

    // Compute utilization — sum all input token types (uncached + cache creation + cache read)
    const totalInput = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
    const utilization = ws > 0 ? totalInput / ws : 0;
    const threshold = classifyThreshold(utilization);
    const formatted = formatGauge(utilization, totalInput, ws);

    return {
      status: 'ok',
      usage,
      window_size: ws,
      utilization,
      formatted,
      threshold,
    };
  } catch {
    // NEVER throw — return unavailable
    return { ...UNAVAILABLE_READING, window_size: ws };
  } finally {
    const duration = Date.now() - start;
    recordMetric('token_gauge_read', duration);
  }
}

/**
 * Read token gauge with automatic window size detection. Single transcript read.
 *
 * Strategy:
 * 1. Config override → use that window size (delegates to readTokenGauge)
 * 2. Read transcript once, extract model + usage
 * 3. If model is 1M-capable AND observed tokens > 195k → confirmed 1M
 * 4. Otherwise → 200k (conservative default)
 *
 * This replaces the pattern of calling detectWindowSize() + readTokenGauge() separately.
 * NEVER throws. Always returns a GaugeReading.
 */
export function readTokenGaugeWithDetection(
  transcriptPath: string | undefined,
  configWindowSize?: number,
): GaugeReading {
  const start = Date.now();

  // Config override is authoritative — delegate to readTokenGauge
  if (configWindowSize && configWindowSize > 0) {
    return readTokenGauge(transcriptPath, configWindowSize);
  }

  try {
    if (!transcriptPath) return { ...UNAVAILABLE_READING };

    // Path validation (must be .jsonl under expected directory)
    if (!isValidTranscriptPath(transcriptPath)) return { ...UNAVAILABLE_READING };

    if (!fs.existsSync(transcriptPath)) return { ...UNAVAILABLE_READING };

    let stat: fs.Stats;
    try { stat = fs.statSync(transcriptPath); } catch { return { ...UNAVAILABLE_READING }; }
    if (stat.size === 0 || stat.size > MAX_FILE_SIZE) return { ...UNAVAILABLE_READING };

    // Read only the tail of the file — usage data is in recent entries
    const content = readTailContent(transcriptPath, stat.size);
    if (!content) return { ...UNAVAILABLE_READING };

    // Single parse for both model and usage
    const { model, usage } = extractLastAssistantData(content);
    if (!usage) return { ...UNAVAILABLE_READING };

    const totalInput = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;

    // Determine window size: 1M only when model is capable AND tokens prove it
    const modelIs1MCapable = model ? is1MCapableModel(model) : false;
    const windowSize = (modelIs1MCapable && totalInput > 195_000) ? WINDOW_1M : DEFAULT_WINDOW_SIZE;

    const utilization = windowSize > 0 ? totalInput / windowSize : 0;
    const threshold = classifyThreshold(utilization);
    const formatted = formatGauge(utilization, totalInput, windowSize);

    return { status: 'ok', usage, window_size: windowSize, utilization, formatted, threshold };
  } catch {
    return { ...UNAVAILABLE_READING };
  } finally {
    recordMetric('token_gauge_read_with_detection', Date.now() - start);
  }
}
