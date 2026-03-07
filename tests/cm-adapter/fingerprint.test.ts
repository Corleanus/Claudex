import { describe, it, expect } from 'vitest';
import { normalizeLearningFingerprint } from '../../src/cm-adapter/fingerprint.js';

describe('normalizeLearningFingerprint', () => {
  it('lowercases text', () => {
    expect(normalizeLearningFingerprint('Use SQLite For Storage')).toBe('use sqlite for storage');
  });

  it('strips leading whitespace', () => {
    expect(normalizeLearningFingerprint('  some text')).toBe('some text');
  });

  it('strips leading dashes', () => {
    expect(normalizeLearningFingerprint('- some text')).toBe('some text');
  });

  it('strips leading asterisks', () => {
    expect(normalizeLearningFingerprint('* some text')).toBe('some text');
  });

  it('strips leading bullets (\\u2022)', () => {
    expect(normalizeLearningFingerprint('\u2022 some text')).toBe('some text');
  });

  it('strips leading dots', () => {
    expect(normalizeLearningFingerprint('... some text')).toBe('some text');
  });

  it('strips combined leading special chars', () => {
    expect(normalizeLearningFingerprint(' - * \u2022. actual text')).toBe('actual text');
  });

  it('collapses multiple spaces to single space', () => {
    expect(normalizeLearningFingerprint('use   sqlite   for   storage')).toBe('use sqlite for storage');
  });

  it('trims trailing whitespace', () => {
    expect(normalizeLearningFingerprint('some text   ')).toBe('some text');
  });

  it('handles empty string', () => {
    expect(normalizeLearningFingerprint('')).toBe('');
  });

  it('handles text that is all special chars', () => {
    expect(normalizeLearningFingerprint('- * \u2022 . ')).toBe('');
  });

  it('combines all normalizations', () => {
    // Leading `  - **` is stripped by ^[\s\-*\u2022.]+ regex, leaving "Bold**  text   here  "
    expect(normalizeLearningFingerprint('  - **Bold**  text   here  ')).toBe('bold** text here');
  });
});
