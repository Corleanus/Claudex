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

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REVIEW_PROMPT_PATH = join(__dirname, 'codex-review.md');
const ZERO_SHA = '0000000000000000000000000000000000000000';

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
 * Parse the diff range from git pre-push stdin format.
 * Falls back to tracking branch or HEAD~5 when called directly.
 */
function getChangedRange() {
  const stdin = readStdinSync();

  if (stdin.trim()) {
    // Called as git pre-push hook — parse stdin
    const lines = stdin.trim().split('\n');
    const parts = lines[0].split(' ');
    if (parts.length < 4) {
      console.error('Warning: Unexpected pre-push stdin format. Falling back to HEAD~5..HEAD');
      return 'HEAD~5..HEAD';
    }
    const localSha = parts[1];
    const remoteSha = parts[3];

    if (remoteSha === ZERO_SHA) {
      // New branch — review last 10 commits
      return 'HEAD~10..HEAD';
    }
    return `${remoteSha}..${localSha}`;
  }

  // Called directly — diff against tracking branch
  try {
    const remote = execSync('git rev-parse --abbrev-ref @{u}', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return `${remote}..HEAD`;
  } catch {
    return 'HEAD~5..HEAD';
  }
}

/**
 * Check if codex CLI is available.
 */
function codexAvailable() {
  try {
    execSync('codex --version', {
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

// --- Main ---

try {
  const range = getChangedRange();

  // Get diff stat for summary
  let diffStat;
  try {
    diffStat = execSync(`git diff --stat ${range}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    // Range might be invalid (e.g., shallow clone)
    diffStat = '';
  }

  if (!diffStat) {
    console.log('No changes to review.');
    process.exit(0);
  }

  console.log('=== Codex Pre-Push Review ===');
  console.log('Files changed:');
  console.log(diffStat);
  console.log();

  // Get full diff
  let fullDiff;
  try {
    fullDiff = execSync(`git diff ${range}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB max
    });
  } catch (err) {
    console.error('Warning: Could not compute diff:', err.message);
    console.log('Skipping review.');
    process.exit(0);
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

  // Build the full prompt and write to a temp file (avoids shell escaping issues)
  const prompt = `${reviewPrompt}\n\n## Changes to Review\n\n\`\`\`diff\n${fullDiff}\n\`\`\``;
  const promptFile = writeTempFile(prompt);

  // Check codex availability
  if (!codexAvailable()) {
    console.log('Warning: codex CLI not found. Skipping automated review.');
    console.log('Install with: npm install -g @openai/codex');
    try { unlinkSync(promptFile); } catch { /* ignore */ }
    process.exit(0);
  }

  // Call codex CLI — read prompt from temp file
  let result;
  try {
    // Use execFileSync to avoid shell interpretation issues
    result = execSync(
      `codex --approval-policy never --model gpt-5.3-codex --quiet --prompt-file "${promptFile}"`,
      {
        encoding: 'utf-8',
        timeout: 120_000, // 2 minute timeout
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 5 * 1024 * 1024,
      },
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log('Warning: codex CLI not found. Skipping automated review.');
    } else if (err.killed) {
      console.log('Warning: Codex review timed out (120s). Skipping.');
    } else {
      // codex CLI returned non-zero or other error — don't block
      console.error('Codex review error:', err.message);
      // If there's stdout from the failed command, still check for verdict
      if (err.stdout) {
        result = err.stdout;
      }
    }
  } finally {
    // Clean up temp file
    try { unlinkSync(promptFile); } catch { /* ignore */ }
  }

  // Parse verdict from codex output
  if (result) {
    console.log(result);

    // Look for explicit VERDICT line — NOT brittle substring matching
    const verdictMatch = result.match(/VERDICT:\s*(PASS|BLOCK)/i);
    if (verdictMatch) {
      const verdict = verdictMatch[1].toUpperCase();
      if (verdict === 'BLOCK') {
        console.log('\n=== BLOCKING ISSUES FOUND — Push prevented ===');
        process.exit(1);
      }
    }
  }

  console.log('\n=== Review complete — No blocking issues ===');
  process.exit(0);
} catch (err) {
  // Top-level catch — never block push on script errors
  console.error('Review script error:', err.message);
  process.exit(0);
}
