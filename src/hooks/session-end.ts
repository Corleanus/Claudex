/**
 * Claudex v2 — SessionEnd Hook
 *
 * Final cleanup when a session ends. The most complex hook.
 *
 * Five independent sections, each with its own try/catch:
 * 1. Final transcript snapshot (same pattern as PreCompact, "sessionend" label)
 * 2. Completion marker check (.completed-<session_id>)
 * 3. Fail-safe handoff (only if no marker AND project scope)
 * 4. Session index update (status, ended_at, ended_by)
 * 5. SQLite session update (soft dependency)
 *
 * MUST exit 0 always. One section failing does not prevent others.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { runHook, logToFile } from './_infrastructure.js';
import { PATHS, transcriptDir, completionMarkerPath, sessionDir } from '../shared/paths.js';
import { detectScope } from '../shared/scope-detector.js';
import { SCHEMAS } from '../shared/types.js';
import type { SessionEndInput, HookStdin } from '../shared/types.js';

runHook('session-end', async (input: HookStdin) => {
  const { session_id, transcript_path, cwd } = input;
  const reason = (input as SessionEndInput).reason ?? 'prompt_input_exit';

  const now = new Date();
  const isoTimestamp = now.toISOString();

  // Filesystem-safe timestamp: YYYY-MM-DDTHH-mm-ss-SSS
  const fsTimestamp = isoTimestamp
    .replace(/:/g, '-')
    .replace('.', '-')
    .replace('Z', '');

  // Detect scope
  const scope = detectScope(cwd);

  // Tracking variables — each section updates independently
  let transcriptSaved = false;
  let completionMarkerFound = false;
  let failsafeWritten = false;
  let failsafeLocation = '';
  let sessionIndexUpdated = false;
  let sqliteUpdated = false;

  // =========================================================================
  // Section 1: Final transcript snapshot
  // =========================================================================
  try {
    if (!transcript_path) {
      logToFile('session-end', 'WARN', 'transcript_path missing — skipping transcript snapshot');
    } else if (!fs.existsSync(transcript_path)) {
      logToFile('session-end', 'WARN', `Transcript file does not exist: ${transcript_path}`);
    } else {
      const stat = fs.statSync(transcript_path);
      if (stat.size === 0) {
        logToFile('session-end', 'WARN', `Transcript is empty (0 bytes): ${transcript_path}`);
      } else {
        const destDir = transcriptDir(session_id);
        fs.mkdirSync(destDir, { recursive: true });

        const filename = `${fsTimestamp}-sessionend.jsonl`;
        const destPath = path.join(destDir, filename);

        const content = fs.readFileSync(transcript_path);
        fs.writeFileSync(destPath, content);

        const sha256 = createHash('sha256').update(content).digest('hex');

        const meta = {
          schema: SCHEMAS.TRANSCRIPT_SNAPSHOT.schema,
          version: SCHEMAS.TRANSCRIPT_SNAPSHOT.version,
          session_id,
          trigger: 'sessionend',
          source: 'session-end hook',
          timestamp: isoTimestamp,
          transcript_path,
          snapshot_path: destPath,
          sha256,
          size_bytes: stat.size,
        };

        const metaPath = destPath + '.meta.json';
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');

        transcriptSaved = true;
        logToFile('session-end', 'INFO',
          `Transcript snapshot saved: ${filename} (${stat.size} bytes, sha256=${sha256})`);
      }
    }
  } catch (err) {
    logToFile('session-end', 'ERROR', 'Section 1 (transcript snapshot) failed:', err);
  }

  // =========================================================================
  // Section 2: Completion marker check
  // =========================================================================
  try {
    const markerPath = completionMarkerPath(session_id);

    if (fs.existsSync(markerPath)) {
      completionMarkerFound = true;
      // Delete the marker to prevent stale accumulation
      fs.unlinkSync(markerPath);
      logToFile('session-end', 'INFO', `Completion marker found and deleted: ${markerPath}`);
    } else {
      logToFile('session-end', 'INFO', `No completion marker found at: ${markerPath}`);
    }
  } catch (err) {
    logToFile('session-end', 'ERROR', 'Section 2 (completion marker check) failed:', err);
  }

  // =========================================================================
  // Section 3: Fail-safe handoff (only if no marker AND project scope)
  // =========================================================================
  try {
    if (!completionMarkerFound && scope.type === 'project') {
      const handoffsDir = path.join(scope.path, 'context', 'handoffs');
      fs.mkdirSync(handoffsDir, { recursive: true });

      // Timestamp for filename: YYYY-MM-DD_HH-mm-ss-SSS
      const fileTimestamp = now.toISOString()
        .replace(/T/, '_')
        .replace(/:/g, '-')
        .replace('.', '-')
        .replace('Z', '');

      // Always write auto_handoff_*.md — ACTIVE.md is reserved for explicit /handoff only
      const targetPath = path.join(handoffsDir, `auto_handoff_${fileTimestamp}.md`);

      const handoffContent = `---
handoff_id: auto-${session_id}
created_at: ${isoTimestamp}
type: auto_failsafe
---

# Auto-Generated Session Handoff

Session ended without /endsession. This is a fail-safe handoff.

- **Session ID**: ${session_id}
- **Scope**: project:${scope.name}
- **CWD**: ${cwd}
- **Reason**: ${reason}
- **Timestamp**: ${isoTimestamp}

## Resume Steps
1. Check transcript at ~/.claudex/transcripts/${session_id}/
2. Review the latest transcript snapshot for context
3. Run /starthere to rebuild context
`;

      fs.writeFileSync(targetPath, handoffContent);
      failsafeWritten = true;
      failsafeLocation = targetPath;
      logToFile('session-end', 'INFO', `Fail-safe handoff written: ${targetPath}`);
    } else if (completionMarkerFound) {
      logToFile('session-end', 'INFO', 'Completion marker found — skipping fail-safe handoff');
    } else {
      logToFile('session-end', 'INFO', 'Global scope — skipping fail-safe handoff');
    }
  } catch (err) {
    logToFile('session-end', 'ERROR', 'Section 3 (fail-safe handoff) failed:', err);
  }

  // =========================================================================
  // Section 4: Session index update (with file lock + atomic write)
  // =========================================================================
  try {
    const indexPath = PATHS.sessionIndex;

    if (fs.existsSync(indexPath)) {
      // Acquire file lock (same pattern as session-start)
      const lockPath = indexPath + '.lock';
      let releaseLock: (() => void) | null = null;
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, String(Date.now()));
        fs.closeSync(fd);
        releaseLock = () => { try { fs.unlinkSync(lockPath); } catch { /* already removed */ } };
      } catch {
        // Check for stale lock (>5s)
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 5000) {
            try { fs.unlinkSync(lockPath); } catch { /* race */ }
            try {
              const fd = fs.openSync(lockPath, 'wx');
              fs.writeSync(fd, String(Date.now()));
              fs.closeSync(fd);
              releaseLock = () => { try { fs.unlinkSync(lockPath); } catch { /* already removed */ } };
            } catch { /* still contended */ }
          }
        } catch { /* lock file gone, proceed */ }
        if (!releaseLock) {
          logToFile('session-end', 'WARN', 'Could not acquire index.json lock, proceeding without lock');
        }
      }

      try {
        const raw = fs.readFileSync(indexPath, 'utf-8');
        const indexData = JSON.parse(raw) as {
          schema?: string;
          version?: number;
          sessions?: Array<Record<string, unknown>>;
        };

        if (Array.isArray(indexData.sessions)) {
          const entry = indexData.sessions.find(
            (s) => s.id === session_id || s.session_id === session_id,
          );

          if (entry) {
            entry.status = 'completed';
            entry.ended_at = isoTimestamp;
            entry.ended_by = completionMarkerFound ? 'endsession' : 'hook_failsafe';

            // Atomic write: temp file + rename
            const tmpPath = indexPath + `.tmp.${process.pid}`;
            fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2) + '\n');
            fs.renameSync(tmpPath, indexPath);
            sessionIndexUpdated = true;
            logToFile('session-end', 'INFO',
              `Session index updated: status=completed, ended_by=${entry.ended_by as string}`);
          } else {
            logToFile('session-end', 'WARN',
              `Session ${session_id} not found in index.json`);
          }
        } else {
          logToFile('session-end', 'WARN', 'index.json sessions field is not an array');
        }
      } finally {
        if (releaseLock) releaseLock();
      }
    } else {
      logToFile('session-end', 'WARN', `index.json does not exist: ${indexPath}`);
    }
  } catch (err) {
    logToFile('session-end', 'ERROR', 'Section 4 (session index update) failed:', err);
  }

  // =========================================================================
  // Section 5: SQLite session update (soft dependency)
  // =========================================================================
  try {
    const { getDatabase } = await import('../db/connection.js');
    const { updateSessionStatus } = await import('../db/sessions.js');

    const db = getDatabase();
    if (!db) {
      logToFile('session-end', 'WARN', 'Database connection failed, skipping session status update');
    } else {
      try {
        updateSessionStatus(db, session_id, 'completed', isoTimestamp);
        sqliteUpdated = true;
        logToFile('session-end', 'INFO', 'SQLite session status updated to completed');
      } finally {
        db.close();
      }
    }
  } catch (err) {
    logToFile('session-end', 'WARN', 'Section 5 (SQLite update) failed (soft dependency):', err);
  }

  // =========================================================================
  // Section 6: Retention policy enforcement
  // =========================================================================
  let retentionRan = false;
  try {
    const { loadConfig } = await import('../shared/config.js');
    const config = loadConfig();

    // retention_days=0 means "purge everything immediately" (valid)
    // retention_days=undefined/null means "use default 90 days" — skip here, only run when explicitly configured
    if (config.observation?.retention_days != null) {
      const { enforceRetention } = await import('../lib/retention.js');
      const { getDatabase } = await import('../db/connection.js');

      const retentionDb = getDatabase();
      if (!retentionDb) {
        logToFile('session-end', 'WARN', 'Database connection failed, skipping retention cleanup');
      } else {
        try {
          const retentionResult = enforceRetention(retentionDb, config);
          retentionRan = true;
          if (retentionResult.observationsDeleted > 0 || retentionResult.reasoningDeleted > 0) {
            logToFile('session-end', 'INFO',
              `Retention cleanup: ${retentionResult.observationsDeleted} observations, ${retentionResult.reasoningDeleted} reasoning chains, ${retentionResult.consensusDeleted} consensus deleted (${retentionResult.durationMs}ms)`);
          }
          // Audit the retention action + self-clean old audit entries
          try {
            const { logAudit, cleanOldAuditLogs } = await import('../db/audit.js');
            logAudit(retentionDb, {
              timestamp: new Date().toISOString(),
              timestamp_epoch: Date.now(),
              session_id,
              event_type: 'retention_cleanup',
              actor: 'hook:session-end',
              details: {
                observations: retentionResult.observationsDeleted,
                reasoning: retentionResult.reasoningDeleted,
                consensus: retentionResult.consensusDeleted,
              },
            });
            cleanOldAuditLogs(retentionDb, 30);
          } catch (auditErr) {
            logToFile('session-end', 'WARN', 'Retention audit logging failed (non-fatal):', auditErr);
          }
        } finally {
          retentionDb.close();
        }
      }
    }
  } catch (err) {
    logToFile('session-end', 'WARN', 'Section 6 (retention policy) failed (non-fatal):', err);
  }

  // =========================================================================
  // Section 7: State capture — persist pressure scores and session summary
  // =========================================================================
  let pressureCaptured = false;
  let summaryCaptured = false;

  // 6a: Persist pressure scores from hologram (if available) to DB
  try {
    const { getDatabase } = await import('../db/connection.js');
    const { upsertPressureScore } = await import('../db/pressure.js');
    const { loadConfig } = await import('../shared/config.js');

    const config = loadConfig();
    const db = getDatabase();
    if (!db) {
      logToFile('session-end', 'WARN', 'Database connection failed, skipping pressure score capture');
    } else {
      try {
        if (config.hologram?.enabled) {
        try {
          const { HologramClient } = await import('../hologram/client.js');
          const { SidecarManager } = await import('../hologram/launcher.js');
          const { ProtocolHandler } = await import('../hologram/protocol.js');

          const launcher = new SidecarManager();
          const protocol = new ProtocolHandler();
          const client = new HologramClient(launcher, protocol, config);

          if (client.isAvailable()) {
              const response = await client.query('session-end', 0, session_id);
              const allFiles = [...response.hot, ...response.warm, ...response.cold];

              for (const file of allFiles) {
                upsertPressureScore(db, {
                  file_path: file.path,
                  project: scope.type === 'project' ? scope.name : undefined,
                  raw_pressure: file.raw_pressure,
                  temperature: file.temperature,
                  last_accessed_epoch: Date.now(),
                  decay_rate: 0.05,
                });
              }

              pressureCaptured = true;
              logToFile('session-end', 'INFO',
                `Pressure scores captured from hologram: ${allFiles.length} files`);
            } else {
              logToFile('session-end', 'DEBUG', 'Hologram not available — skipping pressure capture');
            }
          } catch (hologramErr) {
            logToFile('session-end', 'DEBUG', 'Hologram query for pressure capture failed (non-fatal)', hologramErr);
          }
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    logToFile('session-end', 'WARN', 'Section 6a (pressure capture) failed (non-fatal):', err);
  }

  // 6b: Write session summary to flat-file mirror
  try {
    const scopeStr = scope.type === 'project' ? `project:${scope.name}` : 'global';

    const summaryLines = [
      '---',
      `session_id: ${session_id}`,
      `scope: ${scopeStr}`,
      `reason: ${reason}`,
      `started_at: unknown`,
      `ended_at: ${isoTimestamp}`,
      `transcript_saved: ${transcriptSaved}`,
      `completion_marker: ${completionMarkerFound}`,
      `failsafe_written: ${failsafeWritten}`,
      `sqlite_updated: ${sqliteUpdated}`,
      `pressure_captured: ${pressureCaptured}`,
      '---',
      '',
      '# Session Summary',
      '',
      `Session \`${session_id}\` ended at ${isoTimestamp}.`,
      `- **Scope**: ${scopeStr}`,
      `- **Reason**: ${reason}`,
      `- **CWD**: ${cwd}`,
      '',
    ];

    const sessionDirectory = sessionDir(session_id);
    fs.mkdirSync(sessionDirectory, { recursive: true });

    const summaryPath = path.join(sessionDirectory, 'summary.md');
    fs.writeFileSync(summaryPath, summaryLines.join('\n'), 'utf-8');

    summaryCaptured = true;
    logToFile('session-end', 'INFO', `Session summary written: ${summaryPath}`);
  } catch (err) {
    logToFile('session-end', 'WARN', 'Section 6b (session summary) failed (non-fatal):', err);
  }

  // =========================================================================
  // Summary log
  // =========================================================================
  logToFile('session-end', 'INFO', [
    `Session ${session_id} end summary:`,
    `  reason=${reason}`,
    `  scope=${scope.type === 'project' ? `project:${scope.name}` : 'global'}`,
    `  transcriptSaved=${transcriptSaved}`,
    `  completionMarkerFound=${completionMarkerFound}`,
    `  failsafeWritten=${failsafeWritten}`,
    `  failsafeLocation=${failsafeLocation || '(none)'}`,
    `  sessionIndexUpdated=${sessionIndexUpdated}`,
    `  sqliteUpdated=${sqliteUpdated}`,
    `  retentionRan=${retentionRan}`,
    `  pressureCaptured=${pressureCaptured}`,
    `  summaryCaptured=${summaryCaptured}`,
  ].join('\n'));

  return {};
});
