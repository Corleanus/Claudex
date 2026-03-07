import { describe, it, expect } from 'vitest';
import { isSemanticDuplicate } from '../../src/cm-adapter/dedup.js';

describe('isSemanticDuplicate', () => {
  // ── Tier 1: Normalized exact match ─────────────────────────────────
  describe('Tier 1 — normalized match', () => {
    it('detects exact same text', () => {
      expect(isSemanticDuplicate('use SQLite for storage', 'use SQLite for storage')).toBe(true);
    });

    it('detects same text with different casing', () => {
      expect(isSemanticDuplicate('Use SQLite For Storage', 'use sqlite for storage')).toBe(true);
    });

    it('detects same text with different bullet prefixes', () => {
      expect(isSemanticDuplicate('- use SQLite for storage', '* use SQLite for storage')).toBe(true);
    });

    it('detects same text with numbered vs bullet prefix', () => {
      expect(isSemanticDuplicate('1. use SQLite for storage', '- use SQLite for storage')).toBe(true);
    });

    it('detects same text with/without bold markdown', () => {
      expect(isSemanticDuplicate('- **use** SQLite for storage', '- use SQLite for storage')).toBe(true);
    });

    it('collapses whitespace differences', () => {
      expect(isSemanticDuplicate('use   SQLite   for   storage', 'use SQLite for storage')).toBe(true);
    });
  });

  // ── Tier 2: Keyword Jaccard ────────────────────────────────────────
  describe('Tier 2 — keyword Jaccard', () => {
    it('detects texts sharing most keywords but different phrasing', () => {
      // Both share: sqlite, storage, adapter, pattern (4 of ~5-6 union keywords)
      expect(isSemanticDuplicate(
        'implement SQLite storage with adapter pattern',
        'adapter pattern for SQLite storage layer',
      )).toBe(true);
    });

    it('rejects texts with few shared keywords', () => {
      expect(isSemanticDuplicate(
        'implement SQLite storage with adapter pattern',
        'deploy Redis caching with proxy middleware',
      )).toBe(false);
    });

    it('skips Jaccard when union < 3 keywords', () => {
      // Very short: after stop word filtering, union might be < 3
      // "fix bug" → keywords: fix, bug (2). "fix issue" → keywords: fix, issue (2). Union = 3 (fix, bug, issue)
      // Actually let's use truly short texts
      expect(isSemanticDuplicate('fix it', 'run it')).toBe(false);
    });

    it('uses threshold 0.4 for 6+ keywords (min side)', () => {
      // 6+ keywords on min side → threshold 0.4
      // a: sqlite storage adapter pattern implementation layer (6 kw)
      // b: sqlite storage adapter configuration setup deployment testing (7 kw)
      // shared: sqlite, storage, adapter → 3 intersection
      // union: sqlite storage adapter pattern implementation layer configuration setup deployment testing → 10
      // 3/10 = 0.3 < 0.4 → false
      expect(isSemanticDuplicate(
        'sqlite storage adapter pattern implementation layer',
        'sqlite storage adapter configuration setup deployment testing',
      )).toBe(false);
    });

    it('uses threshold 0.5 for fewer than 6 keywords', () => {
      // < 6 keywords → threshold 0.5
      // a: "sqlite adapter pattern" → 3 kw: sqlite, adapter, pattern
      // b: "sqlite adapter layer" → 3 kw: sqlite, adapter, layer
      // intersection: 2 (sqlite, adapter), union: 4 (sqlite, adapter, pattern, layer)
      // 2/4 = 0.5 >= 0.5 → true
      expect(isSemanticDuplicate(
        'sqlite adapter pattern',
        'sqlite adapter layer',
      )).toBe(true);
    });

    it('filters stop words from keyword extraction', () => {
      // "the" and "a" and "is" are stop words, should be excluded
      expect(isSemanticDuplicate(
        'the implementation is great and complete',
        'a implementation that is great and finished',
      )).toBe(true); // share "implementation", "great" — depends on Jaccard
    });
  });

  // ── Tier 3: Substring containment ──────────────────────────────────
  describe('Tier 3 — substring containment', () => {
    it('detects short text that is a substring of longer text', () => {
      expect(isSemanticDuplicate(
        'use sqlite storage',
        'we decided to use sqlite storage for the adapter',
      )).toBe(true);
    });

    it('rejects substring shorter than 10 chars (but may match via Jaccard)', () => {
      // "fix bug" normalized is 7 chars (< 10), so substring tier skips it.
      // However, keywords {fix, bug} overlap with {fix, bug, parser} → Jaccard 2/3 = 0.67 >= 0.5 → true.
      // Use texts with no keyword overlap to truly test substring length gate.
      expect(isSemanticDuplicate('ab cdefgh', 'xy ab cdefgh zw long enough text')).toBe(false);
    });

    it('rejects substring not on word boundary', () => {
      // "sqlite stor" appears inside "sqlite storage" but "stor" is not word-boundary terminated
      // normalized a: "sqlite stor" (11 chars), normalized b: "sqlite storage layer"
      // "sqlite stor" IS a prefix of "sqlite storage" — but after "stor" comes "a" which is \w → not word boundary
      expect(isSemanticDuplicate(
        'sqlite stor',
        'sqlite storage layer implementation',
      )).toBe(false);
    });

    it('accepts substring at word boundary', () => {
      // "use sqlite" (10 chars) contained in "use sqlite for storage" at word boundary
      expect(isSemanticDuplicate(
        'use sqlite',
        'use sqlite for storage',
      )).toBe(true);
    });

    it('rejects completely different texts', () => {
      expect(isSemanticDuplicate(
        'deploy redis caching layer',
        'implement graphql schema validation',
      )).toBe(false);
    });
  });
});
