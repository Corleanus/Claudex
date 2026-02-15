/**
 * Claudex v2 — Pre-Compaction Flush Trigger
 *
 * Orchestrates the flush sequence: capture reasoning, observations,
 * pressure scores to DB + flat files, then signal hologram re-score.
 * Never throws — returns a summary of what was captured.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { Scope, ReasoningChain, PressureScore } from '../shared/types.js';
import { CLAUDEX_HOME } from '../shared/paths.js';
import { createLogger } from '../shared/logger.js';
import { recordMetric } from '../shared/metrics.js';

const log = createLogger('flush-trigger');

/** File-based cooldown marker so cooldown survives across hook process invocations. */
const COOLDOWN_FILE = path.join(CLAUDEX_HOME, 'db', '.flush_cooldown');

export interface FlushResult {
  reasoningCaptured: number;
  pressureScoresFlushed: number;
  hologramRescored: boolean;
  mirrorFilesWritten: number;
  durationMs: number;
}

export interface FlushOptions {
  db: Database.Database;
  sessionId: string;
  scope: Scope;
  /** Raw reasoning text to capture (e.g., from transcript or Flow) */
  reasoningText?: string;
  /** Pressure scores to persist */
  pressureScores?: PressureScore[];
  /** Whether to attempt hologram re-score */
  hologramRescore?: boolean;
}

/**
 * Read the last flush epoch from the persistent cooldown file.
 * Returns 0 if file doesn't exist or is unreadable.
 */
function readCooldownEpoch(): number {
  try {
    const content = fs.readFileSync(COOLDOWN_FILE, 'utf-8').trim();
    const epoch = Number(content);
    return Number.isFinite(epoch) ? epoch : 0;
  } catch {
    return 0;
  }
}

/**
 * Write the current epoch to the persistent cooldown file.
 */
function writeCooldownEpoch(epoch: number): void {
  try {
    fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
    fs.writeFileSync(COOLDOWN_FILE, String(epoch), 'utf-8');
  } catch (err) {
    log.warn('Failed to write cooldown marker:', err);
  }
}

/**
 * Check if cooldown has elapsed since last flush.
 * Reads from persistent file so cooldown survives across hook process invocations.
 */
export function isCooldownActive(cooldownMs: number): boolean {
  const lastFlushEpoch = readCooldownEpoch();
  return (Date.now() - lastFlushEpoch) < cooldownMs;
}

/**
 * Execute the pre-compaction flush sequence.
 *
 * Steps:
 * 1. Capture reasoning chain to DB
 * 2. Persist pressure scores to DB
 * 3. Write flat-file mirrors
 * 4. Request hologram re-score (if available)
 *
 * Never throws — logs errors and returns partial results.
 */
export async function executeFlush(options: FlushOptions): Promise<FlushResult> {
  const startMs = Date.now();
  const result: FlushResult = {
    reasoningCaptured: 0,
    pressureScoresFlushed: 0,
    hologramRescored: false,
    mirrorFilesWritten: 0,
    durationMs: 0,
  };

  // Step 1: Capture reasoning chain
  if (options.reasoningText && options.reasoningText.trim().length > 0) {
    try {
      const { insertReasoning } = await import('../db/reasoning.js');
      const { mirrorReasoning } = await import('../lib/flat-file-mirror.js');

      const chain: Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'> = {
        session_id: options.sessionId,
        project: options.scope.type === 'project' ? options.scope.name : undefined,
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        trigger: 'pre_compact',
        title: `Pre-flush reasoning — session ${options.sessionId}`,
        reasoning: options.reasoningText.slice(-10000), // Last 10k chars
        importance: 3,
      };

      const inserted = insertReasoning(options.db, chain);
      if (inserted.id > 0) {
        result.reasoningCaptured = 1;
        // Write flat-file mirror
        mirrorReasoning({ ...chain, id: inserted.id } as ReasoningChain, options.scope);
        result.mirrorFilesWritten++;
      }
    } catch (err) {
      log.error('Reasoning capture failed during flush:', err);
    }
  }

  // Step 2: Persist pressure scores
  if (options.pressureScores && options.pressureScores.length > 0) {
    try {
      const { upsertPressureScore } = await import('../db/pressure.js');
      const { mirrorPressureScores } = await import('../lib/flat-file-mirror.js');

      for (const score of options.pressureScores) {
        upsertPressureScore(options.db, score);
        result.pressureScoresFlushed++;
      }

      // Write pressure mirror (snapshot)
      mirrorPressureScores(options.pressureScores, options.scope);
      result.mirrorFilesWritten++;
    } catch (err) {
      log.error('Pressure score flush failed:', err);
    }
  }

  // Step 3: Hologram re-score (via resilient API with DB fallback)
  if (options.hologramRescore !== false) {
    try {
      const { SidecarManager } = await import('../hologram/launcher.js');
      const { ProtocolHandler } = await import('../hologram/protocol.js');
      const { HologramClient } = await import('../hologram/client.js');
      const { rescoreWithFallback } = await import('../hologram/degradation.js');
      const { loadConfig } = await import('../shared/config.js');

      const config = loadConfig();
      const launcher = new SidecarManager();
      const protocol = new ProtocolHandler(config.hologram?.timeout_ms ?? 2000);
      const client = new HologramClient(launcher, protocol, config);
      const project = options.scope.type === 'project' ? options.scope.name : undefined;

      const rescoreResult = await rescoreWithFallback(client, options.sessionId, options.db, project);
      result.hologramRescored = rescoreResult.source !== 'none';

      log.info(`Hologram re-score: source=${rescoreResult.source}`);
    } catch (err) {
      log.warn('Hologram re-score failed (non-fatal):', err);
    }
  }

  // Update cooldown (persisted to file for cross-process durability)
  writeCooldownEpoch(Date.now());
  result.durationMs = Date.now() - startMs;

  recordMetric('flush.trigger', result.durationMs);

  log.info('Flush complete', {
    reasoning: result.reasoningCaptured,
    pressure: result.pressureScoresFlushed,
    mirrors: result.mirrorFilesWritten,
    hologram: result.hologramRescored,
    ms: result.durationMs,
  });

  return result;
}

/**
 * Reset the cooldown timer. Useful for testing.
 */
export function resetCooldown(): void {
  try {
    fs.unlinkSync(COOLDOWN_FILE);
  } catch {
    // File may not exist — that's fine
  }
}
