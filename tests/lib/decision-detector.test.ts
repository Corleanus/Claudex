/**
 * Claudex v3 — Decision Detector Tests (WP-13)
 *
 * Tests covering: detectApproval, detectDecisionSignal, extractGist.
 * All functions are pure — no I/O, no mocking needed.
 */

import { describe, it, expect } from 'vitest';
import {
  detectApproval,
  detectDecisionSignal,
  extractGist,
} from '../../src/lib/decision-detector.js';

// =============================================================================
// detectApproval
// =============================================================================

describe('detectApproval', () => {
  it('returns true for "yes"', () => {
    expect(detectApproval('yes')).toBe(true);
  });

  it('returns true for "yes please!" (trailing punctuation stripped)', () => {
    expect(detectApproval('yes!')).toBe(true);
  });

  it('returns true for "Yes." (case-insensitive, trailing period stripped)', () => {
    expect(detectApproval('Yes.')).toBe(true);
  });

  it('returns false for "no"', () => {
    expect(detectApproval('no')).toBe(false);
  });

  it('returns false for long message starting with "yes"', () => {
    expect(detectApproval('yes I think we should refactor the entire codebase')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(detectApproval('')).toBe(false);
  });

  it('returns true for "ok"', () => {
    expect(detectApproval('ok')).toBe(true);
  });

  it('returns true for "lgtm"', () => {
    expect(detectApproval('lgtm')).toBe(true);
  });

  it('returns true for "go ahead"', () => {
    expect(detectApproval('go ahead')).toBe(true);
  });

  it('returns true for "sounds good"', () => {
    expect(detectApproval('sounds good')).toBe(true);
  });

  it('returns false for whitespace-only string', () => {
    expect(detectApproval('   ')).toBe(false);
  });
});

// =============================================================================
// detectDecisionSignal
// =============================================================================

describe('detectDecisionSignal', () => {
  it('detects "yes" as approval', () => {
    expect(detectDecisionSignal('yes')).toEqual({ detected: true, type: 'approval' });
  });

  it('detects "use Redis for caching" as choice', () => {
    expect(detectDecisionSignal('use Redis for caching')).toEqual({ detected: true, type: 'choice' });
  });

  it('detects "no" as rejection', () => {
    expect(detectDecisionSignal('no')).toEqual({ detected: true, type: 'rejection' });
  });

  it('returns null for general message', () => {
    expect(detectDecisionSignal('tell me about the architecture')).toBeNull();
  });

  it('detects "go with TypeScript" as choice', () => {
    expect(detectDecisionSignal('go with TypeScript')).toEqual({ detected: true, type: 'choice' });
  });

  it('detects "pick option A" as choice', () => {
    expect(detectDecisionSignal('pick option A')).toEqual({ detected: true, type: 'choice' });
  });

  it('detects "stop" as rejection', () => {
    expect(detectDecisionSignal('stop')).toEqual({ detected: true, type: 'rejection' });
  });

  it('returns null for empty string', () => {
    expect(detectDecisionSignal('')).toBeNull();
  });

  it('returns null for a long non-matching message', () => {
    expect(detectDecisionSignal('Can you explain how the hologram sidecar queries work?')).toBeNull();
  });
});

// =============================================================================
// extractGist
// =============================================================================

describe('extractGist', () => {
  it('returns short message as-is', () => {
    expect(extractGist('short msg', 100)).toBe('short msg');
  });

  it('cuts at first sentence boundary when within maxLen', () => {
    const result = extractGist('First sentence. Second sentence. Third.', 20);
    expect(result).toBe('First sentence...');
  });

  it('truncates at maxLen when no sentence boundary exists within limit', () => {
    const result = extractGist('Very long message without periods that goes on and on', 20);
    expect(result).toBe('Very long message wi...');
  });

  it('cuts at newline when newline is before maxLen', () => {
    const result = extractGist('First line\nSecond line here', 20);
    expect(result).toBe('First line...');
  });

  it('returns message exactly at maxLen as-is (no ellipsis)', () => {
    const msg = 'exactly twenty chars';  // 20 chars
    expect(extractGist(msg, 20)).toBe(msg);
  });

  it('uses default maxLen of 100', () => {
    const short = 'A short message';
    expect(extractGist(short)).toBe(short);
  });

  it('trims leading/trailing whitespace before gisting', () => {
    const result = extractGist('  hello world  ', 100);
    expect(result).toBe('hello world');
  });
});
