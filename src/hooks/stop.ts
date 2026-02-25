/**
 * Claudex v3 — Stop Hook (WP-12)
 *
 * Fires at the end of each agent turn. Detects structural signals that suggest
 * decisions were made (file modifications) but not recorded, then nudges the
 * agent to log them via appendDecision().
 *
 * NEVER throws — always returns {}. File reads only, no database access.
 * Must complete in <500ms.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import type { StopInput } from '../shared/types.js';

const HOOK_NAME = 'stop';

// Min turns between nudges to avoid spamming
const NUDGE_COOLDOWN_TURNS = 5;

// Min file-modifying tools to consider nudge-worthy
const FILE_MODIFY_THRESHOLD = 2;

// =============================================================================
// Nudge State
// =============================================================================

interface NudgeState {
  lastNudgeTurn: number;
  turnCount: number;
  lastKnownDecisionCount: number;
}

function emptyNudgeState(): NudgeState {
  return { lastNudgeTurn: 0, turnCount: 0, lastKnownDecisionCount: 0 };
}

/** Read nudge state from YAML. Returns empty state on any error. */
export function readNudgeState(stateDir: string): NudgeState {
  try {
    const filePath = path.join(stateDir, '.nudge-state.yaml');
    if (!fs.existsSync(filePath)) return emptyNudgeState();
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return emptyNudgeState();
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const data = yaml.load(normalized, { schema: yaml.JSON_SCHEMA });
    if (!data || typeof data !== 'object') return emptyNudgeState();
    const obj = data as Record<string, unknown>;
    return {
      lastNudgeTurn: typeof obj['lastNudgeTurn'] === 'number' ? obj['lastNudgeTurn'] : 0,
      turnCount: typeof obj['turnCount'] === 'number' ? obj['turnCount'] : 0,
      lastKnownDecisionCount: typeof obj['lastKnownDecisionCount'] === 'number' ? obj['lastKnownDecisionCount'] : 0,
    };
  } catch {
    return emptyNudgeState();
  }
}

/** Write nudge state to YAML. Silently swallows write errors. */
export function writeNudgeState(stateDir: string, state: NudgeState): void {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
    const filePath = path.join(stateDir, '.nudge-state.yaml');
    const content = yaml.dump(state, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });
    fs.writeFileSync(filePath, content, 'utf-8');
  } catch {
    // Non-fatal — nudge state loss is acceptable
  }
}

// =============================================================================
// Transcript Signal Detection
// =============================================================================

export interface TranscriptSignals {
  fileModifyCount: number;
}

/**
 * Parse the last 10000 bytes of the transcript JSONL for structural signals.
 * Counts tool_use blocks with file-modifying tool names.
 *
 * NOTE: First line in buffer may be partial (mid-line read) — JSON.parse
 * naturally skips it via try/catch. This is intentional.
 */
export function detectDecisionSignals(transcriptPath: string | undefined): TranscriptSignals {
  if (!transcriptPath) return { fileModifyCount: 0 };

  try {
    if (!fs.existsSync(transcriptPath)) return { fileModifyCount: 0 };

    const fd = fs.openSync(transcriptPath, 'r');
    const stat = fs.fstatSync(fd);
    const readSize = Math.min(10000, stat.size);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter(l => l.trim().length > 0);

    let fileModifyCount = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Look for tool_use blocks in message.content arrays
        const content = entry?.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block != null &&
              typeof block === 'object' &&
              block.type === 'tool_use' &&
              ['Write', 'Edit', 'Bash'].includes(block.name)
            ) {
              fileModifyCount++;
            }
          }
        }
      } catch {
        // Skip malformed lines (includes partial first line from mid-buffer read)
      }
    }

    return { fileModifyCount };
  } catch {
    return { fileModifyCount: 0 };
  }
}

// =============================================================================
// Hook Entry Point
// =============================================================================

runHook(HOOK_NAME, async (input) => {
  try {
    const stopInput = input as StopInput;
    const sessionId = stopInput.session_id || 'unknown';
    const cwd = stopInput.cwd || process.cwd();
    const transcriptPath = stopInput.transcript_path;

    // 1. Only nudge in project scope
    const scope = detectScope(cwd);
    if (scope.type !== 'project') {
      return {};
    }

    const projectDir = scope.path;
    const sessionStateDir = path.join(projectDir, 'context', 'state', sessionId);

    // 2. Read nudge state and increment turn counter
    const nudgeState = readNudgeState(sessionStateDir);
    nudgeState.turnCount++;

    // 3. Check rate limit
    const turnsSinceLastNudge = nudgeState.turnCount - nudgeState.lastNudgeTurn;
    const rateLimited = nudgeState.lastNudgeTurn > 0 && turnsSinceLastNudge < NUDGE_COOLDOWN_TURNS;

    if (rateLimited) {
      // Still write updated turn count
      writeNudgeState(sessionStateDir, nudgeState);
      return {};
    }

    // 4. Read decision count for this session
    let decisionCount = 0;
    try {
      const { readDecisions } = await import('../checkpoint/state-files.js');
      const decisions = readDecisions(projectDir, sessionId);
      decisionCount = decisions.length;
    } catch {
      // Non-fatal — proceed without decision count
    }

    // 5. Detect structural signals from transcript
    const signals = detectDecisionSignals(transcriptPath);

    // 6. Nudge condition: significant file changes AND no new decisions recorded since last nudge
    const noNewDecisions = decisionCount <= nudgeState.lastKnownDecisionCount;
    const shouldNudge = signals.fileModifyCount >= FILE_MODIFY_THRESHOLD && noNewDecisions;

    if (shouldNudge) {
      nudgeState.lastNudgeTurn = nudgeState.turnCount;
      nudgeState.lastKnownDecisionCount = decisionCount;
      writeNudgeState(sessionStateDir, nudgeState);

      logToFile(HOOK_NAME, 'DEBUG',
        `Nudge: fileModifyCount=${signals.fileModifyCount}, decisionCount=${decisionCount}, turn=${nudgeState.turnCount}`
      );

      return {
        hookSpecificOutput: {
          hookEventName: 'Stop',
          additionalContext: 'Tip: You made significant file changes this turn but logged no decisions. Consider recording key decisions via appendDecision() to context/state/decisions.yaml — this preserves decision rationale across compactions.',
        },
      };
    }

    // Update state with current decision count (no nudge this turn)
    nudgeState.lastKnownDecisionCount = decisionCount;
    writeNudgeState(sessionStateDir, nudgeState);

  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'Stop hook error (non-fatal)', err);
  }

  return {};
});
