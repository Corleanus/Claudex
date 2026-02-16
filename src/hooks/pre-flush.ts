/**
 * Claudex v2 — PreFlush Hook
 *
 * Fires when the context window reaches the flush threshold (default 80%).
 * Orchestrates the pre-compaction memory flush: captures reasoning,
 * persists pressure scores, writes flat-file mirrors, signals hologram.
 *
 * Gated behind config.wrapper?.enabled — no-op if disabled.
 * Respects cooldown to prevent rapid re-flushes.
 * NEVER throws — exits 0 always. Fail open (let compaction proceed).
 */

import { runHook, logToFile } from './_infrastructure.js';
import { loadConfig } from '../shared/config.js';
import { detectScope } from '../shared/scope-detector.js';
import { getDatabase } from '../db/connection.js';
import { assessUtilization, shouldFlush } from '../wrapper/context-monitor.js';
import { executeFlush, isCooldownActive } from '../wrapper/flush-trigger.js';
import { getPressureScores } from '../db/pressure.js';
import type { HookStdin } from '../shared/types.js';

const HOOK_NAME = 'pre-flush';

runHook(HOOK_NAME, async (input: HookStdin) => {
  const config = loadConfig();

  // Gate: wrapper disabled
  if (config.wrapper?.enabled === false) {
    logToFile(HOOK_NAME, 'DEBUG', 'Wrapper disabled in config, skipping');
    return {};
  }

  const warnThreshold = config.wrapper?.warnThreshold ?? 0.70;
  const flushThreshold = config.wrapper?.flushThreshold ?? 0.80;
  const cooldownMs = config.wrapper?.cooldownMs ?? 30000;

  // The hook receives token counts via the input (Claude Code passes these)
  // Fall back to 0 if not available (hook becomes no-op)
  const inputAny = input as unknown as Record<string, unknown>;
  const currentTokens = (inputAny.current_tokens as number) ?? 0;
  const maxTokens = (inputAny.max_tokens as number) ?? 0;

  if (maxTokens <= 0) {
    logToFile(HOOK_NAME, 'DEBUG', 'No token counts in input, skipping');
    return {};
  }

  // Assess utilization
  const utilization = assessUtilization(currentTokens, maxTokens, { warnThreshold, flushThreshold });
  logToFile(HOOK_NAME, 'DEBUG', `Utilization: ${(utilization.utilization * 100).toFixed(1)}% (${utilization.level})`);

  // Warn level — log but don't flush
  if (utilization.level === 'warn') {
    logToFile(HOOK_NAME, 'INFO', `Context at ${(utilization.utilization * 100).toFixed(1)}% — approaching flush threshold`);
    return {};
  }

  // Below threshold — nothing to do
  if (!shouldFlush(utilization)) {
    return {};
  }

  // Cooldown check
  if (isCooldownActive(cooldownMs)) {
    logToFile(HOOK_NAME, 'DEBUG', 'Flush cooldown active, skipping');
    return {};
  }

  logToFile(HOOK_NAME, 'INFO', `Flush threshold reached (${(utilization.utilization * 100).toFixed(1)}%), executing flush`);

  // Execute flush
  const scope = detectScope(input.cwd);

  try {
    const db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping pressure score retrieval');
      return {};
    }
    try {
      const project = scope.type === 'project' ? scope.name : undefined;
      const pressureScores = getPressureScores(db, project);

      // Note: reasoningText is NOT provided here by design.
      // Pre-flush fires BEFORE compaction — reasoning/Flow hasn't been generated yet.
      // Reasoning capture is handled by the pre-compact hook instead.
      const result = await executeFlush({
        db,
        sessionId: input.session_id,
        scope,
        pressureScores,
        hologramRescore: true,
      });

      logToFile(HOOK_NAME, 'INFO', `Flush complete: reasoning=${result.reasoningCaptured}, pressure=${result.pressureScoresFlushed}, mirrors=${result.mirrorFilesWritten}, hologram=${result.hologramRescored}, duration=${result.durationMs}ms`);
    } finally {
      db.close();
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'ERROR', 'DB operation failed (non-fatal):', err);
  }

  return {};
});
