/**
 * Claudex v2 — PreCompact Hook
 *
 * Captures a transcript snapshot before context compaction.
 * Copies the transcript file to ~/.claudex/transcripts/<session_id>/
 * with a timestamped filename and writes a .meta.json sidecar.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runHook, logToFile } from './_infrastructure.js';
import { transcriptDir } from '../shared/paths.js';
import type { PreCompactInput } from '../shared/types.js';
import type { HookStdin } from '../shared/types.js';
import type { ReasoningChain } from '../shared/types.js';
import { SCHEMAS } from '../shared/types.js';
import { detectScope } from '../shared/scope-detector.js';
import { getDatabase } from '../db/connection.js';
import { insertReasoning } from '../db/reasoning.js';

runHook('pre-compact', async (input: HookStdin) => {
  const { session_id, transcript_path } = input;
  const trigger = (input as PreCompactInput).trigger ?? 'auto';

  // Guard: missing transcript_path
  if (!transcript_path) {
    logToFile('pre-compact', 'WARN', 'transcript_path missing from input — skipping');
    return {};
  }

  // Guard: file does not exist
  if (!fs.existsSync(transcript_path)) {
    logToFile('pre-compact', 'WARN', `Transcript file does not exist: ${transcript_path}`);
    return {};
  }

  // Guard: empty file
  let stat: fs.Stats;
  try {
    stat = fs.statSync(transcript_path);
  } catch (err) {
    logToFile('pre-compact', 'WARN', `Cannot stat transcript: ${transcript_path}`, err);
    return {};
  }

  if (stat.size === 0) {
    logToFile('pre-compact', 'WARN', `Transcript is empty (0 bytes): ${transcript_path}`);
    return {};
  }

  // Build destination path
  const destDir = transcriptDir(session_id);
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to create transcript dir: ${destDir}`, err);
    return {};
  }

  // Timestamp with hyphens (filesystem-safe)
  const now = new Date();
  const ts = now.toISOString()
    .replace(/:/g, '-')     // HH:mm:ss → HH-mm-ss
    .replace(/\.\d{3}Z$/, ''); // strip millis + Z

  const filename = `${ts}-precompact-${trigger}.jsonl`;
  const destPath = path.join(destDir, filename);

  // Copy transcript
  let content: Buffer;
  try {
    content = fs.readFileSync(transcript_path);
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to read transcript: ${transcript_path}`, err);
    return {};
  }

  try {
    fs.writeFileSync(destPath, content);
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to write transcript copy: ${destPath}`, err);
    return {};
  }

  // Compute SHA256
  const sha256 = createHash('sha256').update(content).digest('hex');

  // Write .meta.json
  const metaPath = destPath + '.meta.json';
  const meta = {
    schema: SCHEMAS.TRANSCRIPT_SNAPSHOT.schema,
    version: SCHEMAS.TRANSCRIPT_SNAPSHOT.version,
    session_id,
    trigger: 'precompact',
    source: 'pre-compact hook',
    timestamp: now.toISOString(),
    transcript_path,
    snapshot_path: destPath,
    sha256,
    size_bytes: stat.size,
  };

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  } catch (err) {
    logToFile('pre-compact', 'ERROR', `Failed to write metadata: ${metaPath}`, err);
    return {};
  }

  logToFile('pre-compact', 'INFO',
    `Snapshot saved: ${filename} (${stat.size} bytes, sha256=${sha256})`);

  // =========================================================================
  // Reasoning chain capture — store pre-compaction reasoning to DB + flat file
  // =========================================================================
  const HOOK_NAME = 'pre-compact';
  const MAX_REASONING_LENGTH = 10000;

  try {
    // 1. Detect scope
    const scope = detectScope(input.cwd);
    logToFile(HOOK_NAME, 'DEBUG', `Scope detected: ${scope.type}${scope.type === 'project' ? ` (${scope.name})` : ''}`);

    // 2. Open DB
    const db = getDatabase();

    try {
      // 3. Read transcript content
      let transcriptContent: string | undefined;
      if (transcript_path) {
        try {
          transcriptContent = fs.readFileSync(transcript_path, 'utf-8');
        } catch (readErr) {
          logToFile(HOOK_NAME, 'WARN', `Failed to read transcript for reasoning capture: ${transcript_path}`, readErr);
        }
      }

      // Truncate to last MAX_REASONING_LENGTH chars (most recent reasoning is most valuable)
      let reasoning = transcriptContent || 'Transcript unavailable';
      if (reasoning.length > MAX_REASONING_LENGTH) {
        reasoning = reasoning.slice(-MAX_REASONING_LENGTH);
        logToFile(HOOK_NAME, 'DEBUG', `Reasoning truncated to last ${MAX_REASONING_LENGTH} chars`);
      }

      // 4. Build reasoning chain
      const chainTimestamp = new Date().toISOString();
      const chain: Omit<ReasoningChain, 'id' | 'created_at' | 'created_at_epoch'> = {
        session_id,
        project: scope.type === 'project' ? scope.name : undefined,
        timestamp: chainTimestamp,
        timestamp_epoch: Date.now(),
        trigger: 'pre_compact',
        title: `Pre-compaction reasoning snapshot — session ${session_id}`,
        reasoning,
        importance: 3,
      };

      // 5. Insert into DB
      const result = insertReasoning(db, chain);
      logToFile(HOOK_NAME, 'DEBUG', `Reasoning chain inserted with id=${result.id}`);

      // 6. Write flat-file mirror
      const safeTsForFile = chainTimestamp
        .replace(/:/g, '-')
        .replace(/\.\d{3}Z$/, '');

      let reasoningDir: string;
      if (scope.type === 'project') {
        reasoningDir = path.join(scope.path, 'context', 'reasoning', session_id);
      } else {
        reasoningDir = path.join(os.homedir(), '.claudex', 'reasoning', session_id);
      }

      fs.mkdirSync(reasoningDir, { recursive: true });

      const mirrorFilename = `pre_compact_${safeTsForFile}.md`;
      const mirrorPath = path.join(reasoningDir, mirrorFilename);

      const mirrorContent = [
        `# ${chain.title}`,
        '',
        `**Trigger**: ${chain.trigger}`,
        `**Session**: ${session_id}`,
        `**Timestamp**: ${chainTimestamp}`,
        `**Importance**: ${chain.importance}/5`,
        scope.type === 'project' ? `**Project**: ${scope.name}` : '**Scope**: global',
        '',
        '---',
        '',
        chain.reasoning,
        '',
      ].join('\n');

      fs.writeFileSync(mirrorPath, mirrorContent, 'utf-8');
      logToFile(HOOK_NAME, 'DEBUG', `Reasoning flat-file mirror written: ${mirrorPath}`);
    } finally {
      // 7. Close DB
      db.close();
    }
  } catch (reasoningErr) {
    // Reasoning capture failure must NOT fail the hook — transcript snapshot is already saved
    logToFile(HOOK_NAME, 'ERROR', 'Reasoning chain capture failed (non-fatal):', reasoningErr);
  }

  return {};
});
