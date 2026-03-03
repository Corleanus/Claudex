#!/usr/bin/env node
/**
 * Claudex v2 — Codex Pre-Push Review
 *
 * Cross-platform Node.js script that runs Codex review on changes being pushed.
 * Called as a git pre-push hook (receives refs on stdin) or directly from CLI.
 *
 * Exit 0 = pass (or error/missing CLI — never block on infrastructure failure)
 * Exit 1 = blocking issues found (VERDICT: BLOCK)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_PROMPT_PATH = join(__dirname, 'codex-review.md');
const ZERO_SHA = '0000000000000000000000000000000000000000';
const REF_PATTERN = /^[A-Fa-f0-9]{4,40}$/;

/**
 * Read all of stdin synchronously.
 * Git pre-push pipes "local_ref local_sha remote_ref remote_sha\n" lines.
 */
function readStdinSync() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Get a safe base commit for new branch review.
 * Uses merge-base with main/master, falling back to rev-list count guard.
 * Returns null if no safe base can be determined.
 */
function getSafeNewBranchBase() {
  for (const base of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const mergeBase = execFileSync('git', ['merge-base', base, 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // Branch doesn't exist — try next
    }
  }

  // Fallback: use rev-list to find how many commits exist, cap at 10
  try {
    const countStr = execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const count = parseInt(countStr, 10);
    if (isNaN(count) || count <= 0) return null;
    const safeCount = Math.min(count - 1, 10);
    if (safeCount <= 0) return null;
    return `HEAD~${safeCount}`;
  } catch {
    return null;
  }
}

/**
 * Parse diff ranges from git pre-push stdin format.
 * Returns an array of range strings. Falls back to tracking branch or HEAD~5.
 */
function getChangedRanges() {
  const stdin = readStdinSync();

  if (stdin.trim()) {
    const lines = stdin.trim().split('\n');
    const ranges = [];

    for (const line of lines) {
      const parts = line.split(' ');
      if (parts.length < 4) continue;

      const localSha = parts[1];
      const remoteSha = parts[3];

      // Skip delete operations (local is zero)
      if (localSha === ZERO_SHA) continue;

      // Validate ref format
      if (!REF_PATTERN.test(localSha)) continue;

      if (remoteSha === ZERO_SHA) {
        // New branch — use safe base (C17)
        const safeBase = getSafeNewBranchBase();
        if (safeBase) {
          ranges.push(`${safeBase}..${localSha}`);
        }
      } else {
        if (!REF_PATTERN.test(remoteSha)) continue;
        ranges.push(`${remoteSha}..${localSha}`);
      }
    }

    if (ranges.length > 0) return ranges;
  }

  // Called directly — diff against tracking branch
  try {
    const remote = execFileSync('git', ['rev-parse', '--abbrev-ref', '@{u}'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return [`${remote}..HEAD`];
  } catch {
    return ['HEAD~5..HEAD'];
  }
}

/**
 * Check if codex CLI is available.
 */
function codexAvailable() {
  try {
    execFileSync('codex', ['--version'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write content to a temp file, returning the path.
 * Used to pass large prompts without shell escaping issues.
 */
function writeTempFile(content, prefix = 'codex-review-') {
  const name = `${prefix}${randomBytes(8).toString('hex')}.md`;
  const filePath = join(tmpdir(), name);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Basic secret filtering for diff content.
 * Replaces common secret patterns with [REDACTED] before sending externally.
 * Not exhaustive — defense-in-depth layer, not primary protection.
 *
 * NOTE: These patterns are intentionally duplicated from src/lib/redaction.ts
 * (redactSensitive / SECRET_PATTERNS). This .mjs script cannot import TypeScript
 * modules directly. If you update secret patterns, sync both locations.
 * Source of truth: src/lib/redaction.ts
 */
function filterSecrets(text) {
  let filtered = text;
  // API keys, tokens, secrets in assignment context
  filtered = filtered.replace(
    /(?:api[_-]?key|token|secret|password|credential)[s]?\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
    (match) => match.split(/[:=]/)[0] + '= [REDACTED]'
  );
  // AWS access keys
  filtered = filtered.replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g, '[REDACTED-AWS-KEY]');
  // GitHub tokens
  filtered = filtered.replace(/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g, '[REDACTED-GH-TOKEN]');
  // Generic secret-like patterns (sk-..., pk-...)
  filtered = filtered.replace(/(?:sk|pk)[-_][a-zA-Z0-9]{20,}/g, '[REDACTED-KEY]');
  // JWTs
  filtered = filtered.replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED-JWT]');
  return filtered;
}

// --- Main ---

try {
  const ranges = getChangedRanges();
  let hasBlockingIssues = false;

  for (const range of ranges) {
    // Get diff stat for summary
    let diffStat;
    try {
      diffStat = execFileSync('git', ['diff', '--stat', range], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      diffStat = '';
    }

    if (!diffStat) {
      console.log(`No changes to review for range ${range}.`);
      continue;
    }

    console.log(`=== Codex Pre-Push Review (${range}) ===`);
    console.log('Files changed:');
    console.log(diffStat);
    console.log();

    // Get full diff
    let fullDiff;
    try {
      fullDiff = execFileSync('git', ['diff', range], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      console.error('Warning: Could not compute diff:', err.message);
      console.log('Skipping review for this range.');
      continue;
    }

    // Read review prompt template
    let reviewPrompt;
    try {
      reviewPrompt = readFileSync(REVIEW_PROMPT_PATH, 'utf-8');
    } catch {
      console.error('Warning: Could not read review prompt template at', REVIEW_PROMPT_PATH);
      console.log('Skipping review.');
      process.exit(0);
    }

    // R12 fix: filter secrets from diff before sending externally
    const filteredDiff = filterSecrets(fullDiff);
    // Build the full prompt and write to a temp file
    const prompt = `${reviewPrompt}\n\n## Changes to Review\n\n\`\`\`diff\n${filteredDiff}\n\`\`\``;
    const promptFile = writeTempFile(prompt);

    // Check codex availability
    if (!codexAvailable()) {
      console.log('Warning: codex CLI not found. Skipping automated review.');
      console.log('Install with: npm install -g @openai/codex');
      try { unlinkSync(promptFile); } catch { /* ignore */ }
      process.exit(0);
    }

    // Call codex CLI
    let result;
    try {
      result = execFileSync('codex', [
        '--approval-policy', 'never',
        '--model', 'gpt-5.3-codex',
        '--quiet',
        '--prompt-file', promptFile,
      ], {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 5 * 1024 * 1024,
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('Warning: codex CLI not found. Skipping automated review.');
      } else if (err.killed) {
        console.log('Warning: Codex review timed out (120s). Skipping.');
      } else {
        console.error('Codex review error:', err.message);
        if (err.stdout) {
          result = err.stdout;
        }
      }
    } finally {
      try { unlinkSync(promptFile); } catch { /* ignore */ }
    }

    // Parse verdict
    if (result) {
      console.log(result);
      const verdictMatch = result.match(/VERDICT:\s*(PASS|BLOCK)/i);
      if (verdictMatch) {
        const verdict = verdictMatch[1].toUpperCase();
        if (verdict === 'BLOCK') {
          hasBlockingIssues = true;
        }
      }
    }
  }

  if (hasBlockingIssues) {
    console.log('\n=== BLOCKING ISSUES FOUND — Push prevented ===');
    process.exit(1);
  }

  console.log('\n=== Review complete — No blocking issues ===');
  process.exit(0);
} catch (err) {
  // Top-level catch — never block push on script errors
  console.error('Review script error:', err.message);
  process.exit(0);
}
