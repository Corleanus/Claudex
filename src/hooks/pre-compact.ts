/**
 * Claudex v2 — PreCompact Hook
 *
 * Captures a transcript snapshot before context compaction.
 * Copies the transcript file to ~/.claudex/transcripts/<session_id>/
 * with a timestamped filename and writes a .meta.json sidecar.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runHook, logToFile } from './_infrastructure.js';
import { transcriptDir } from '../shared/paths.js';
import type { PreCompactInput } from '../shared/types.js';
import type { HookStdin } from '../shared/types.js';
import { SCHEMAS } from '../shared/types.js';

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

  return {};
});
