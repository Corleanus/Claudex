/**
 * Claudex v3 — Decision Pattern Detector
 *
 * Pure functions for detecting approval patterns and extracting message gists.
 * No I/O, no side effects — easy to test.
 */

/**
 * Detect if a user message is a short approval/confirmation.
 * Only matches very short messages (< 30 chars) with clear approval words.
 * Returns false for anything ambiguous.
 */
export function detectApproval(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;

  const normalized = trimmed.toLowerCase().replace(/[.,!?]+$/g, '');

  const APPROVAL_WORDS = new Set([
    'yes', 'yep', 'yeah', 'yea', 'y',
    'ok', 'okay', 'sure', 'go', 'approved',
    'lgtm', 'looks good', 'proceed', 'confirmed',
    'correct', 'exactly', 'perfect', 'do it',
    'go ahead', 'go for it', 'sounds good',
    'that works', 'makes sense', 'ship it',
    'merge it', 'deploy', 'deploy it',
    "let's do it", "let's go",
  ]);

  return APPROVAL_WORDS.has(normalized);
}

/**
 * Classify a user message as approval, choice, rejection, or null.
 * Used for auto-detecting decisions.
 */
export function detectDecisionSignal(message: string): { detected: boolean; type: 'approval' | 'choice' | 'rejection' } | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // Approval (short affirmatives)
  if (detectApproval(trimmed)) {
    return { detected: true, type: 'approval' };
  }

  // Choice patterns (any length): "use X", "go with X", "pick X", "choose X"
  if (/\b(use|go with|pick|choose|prefer|switch to|let's use)\b/i.test(trimmed) && trimmed.length < 200) {
    return { detected: true, type: 'choice' };
  }

  // Rejection (short negatives, < 30 chars)
  if (trimmed.length <= 30) {
    const negNormalized = trimmed.toLowerCase().replace(/[.,!?]+$/g, '');
    const REJECTION_WORDS = new Set([
      'no', 'nope', 'nah', 'wrong', 'not that',
      "don't", "don't do that", 'stop', 'cancel', 'revert',
    ]);
    if (REJECTION_WORDS.has(negNormalized)) {
      return { detected: true, type: 'rejection' };
    }
  }

  return null;
}

/**
 * Extract a brief gist from a message.
 * If short enough, return as-is. Otherwise truncate at first sentence boundary.
 */
export function extractGist(message: string, maxLen: number = 100): string {
  const trimmed = message.trim();
  if (trimmed.length <= maxLen) return trimmed;

  // Try to cut at first sentence boundary
  const sentenceEnd = trimmed.indexOf('. ');
  const newlineEnd = trimmed.indexOf('\n');

  let cutPoint = maxLen;
  if (sentenceEnd > 0 && sentenceEnd < maxLen) cutPoint = sentenceEnd;
  else if (newlineEnd > 0 && newlineEnd < maxLen) cutPoint = newlineEnd;

  return trimmed.slice(0, cutPoint).trim() + '...';
}
