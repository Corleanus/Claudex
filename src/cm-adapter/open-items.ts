/**
 * CM Adapter — Open Items Scanner
 *
 * Ported from OpenClaw Context Manager's open items capture logic.
 * Scans assistant messages for TODO/FIXME/action-needed patterns.
 */

import { linesOutsideCodeFences } from './code-fence.js';
import { batchAppendOpenItems } from './state-files.js';

/**
 * Scan assistant text for open items (TODOs, unchecked checkboxes, action keywords).
 * Collects all candidates first, then writes once via batched dedup.
 */
export async function scanAndCaptureOpenItems(
  sessionId: string,
  assistantText: string,
): Promise<void> {
  const candidates: string[] = [];

  for (const { raw, trimmed } of linesOutsideCodeFences(assistantText)) {
    const isCheckbox = /^\s*-\s*\[\s*\]/.test(raw);
    const isBulletOrNumbered = /^[-*]|^\d+\./.test(trimmed);
    const hasActionKeyword = /\b(need to|TODO|still need|will check|remaining:|next step|haven't yet|FIXME)\b/i.test(raw);
    const isBulletWithAction = isBulletOrNumbered && hasActionKeyword;

    if (isCheckbox || isBulletWithAction) {
      const item = trimmed.length > 150 ? trimmed.slice(0, 147) + '...' : trimmed;
      candidates.push(item);
    }
  }

  await batchAppendOpenItems(sessionId, candidates);
}
