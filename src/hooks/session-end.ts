/**
 * Claudex v2 — SessionEnd Hook
 *
 * Final cleanup when a session ends. The most complex hook.
 *
 * Six independent phases, each with its own error handling:
 * 1. Final transcript snapshot (same pattern as PreCompact, "sessionend" label)
 * 2. Completion marker check (.completed-<session_id>)
 * 3. Fail-safe handoff (project scope only, no marker)
 * 4. Session index update (file lock + atomic write)
 * 5-9. DB-dependent phase (single shared connection):
 *   5. SQLite session status update (runSqliteUpdate)
 *   6. Retention policy enforcement (runRetentionPolicy)
 *   7. State capture — pressure scores + session summary (runPressureCapture, runSessionSummary)
 *   8. Decay pass — stratified half-life (runDecayPass)
 *   9. Observation pruning — lowest-EI soft-delete (runObservationPruning)
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
import { loadConfig } from '../shared/config.js';
import { getDatabase } from '../db/connection.js';
import { updateSessionStatus } from '../db/sessions.js';
import { enforceRetention } from '../lib/retention.js';
import { logAudit, cleanOldAuditLogs } from '../db/audit.js';
import { batchUpsertPressureScores, decayAllScores } from '../db/pressure.js';
import { HologramClient } from '../hologram/client.js';
import { SidecarManager } from '../hologram/launcher.js';
import { ProtocolHandler } from '../hologram/protocol.js';
import { pruneObservations } from '../lib/decay-engine.js';
import type { SessionEndInput, HookStdin, Scope, ClaudexConfig } from '../shared/types.js';

// =============================================================================
// O06: Extracted helper functions for DB-dependent sections 5-9
// =============================================================================

const HOOK = 'session-end';

/** Section 5: Update SQLite session status to completed */
function runSqliteUpdate(
  db: import('better-sqlite3').Database,
  sessionId: string,
  isoTimestamp: string,
): boolean {
  try {
    updateSessionStatus(db, sessionId, 'completed', isoTimestamp);
    logToFile(HOOK, 'INFO', 'SQLite session status updated to completed');
    return true;
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 5 (SQLite update) failed (soft dependency):', err);
    return false;
  }
}

/** Section 6: Enforce retention policy and audit the action */
function runRetentionPolicy(
  db: import('better-sqlite3').Database,
  sessionId: string,
  config: ClaudexConfig,
): boolean {
  try {
    if (config.observation?.retention_days == null) return false;

    const retentionResult = enforceRetention(db, config);

    if (retentionResult.observationsDeleted > 0 || retentionResult.reasoningDeleted > 0) {
      logToFile(HOOK, 'INFO',
        `Retention cleanup: ${retentionResult.observationsDeleted} observations, ${retentionResult.reasoningDeleted} reasoning chains, ${retentionResult.consensusDeleted} consensus deleted (${retentionResult.durationMs}ms)`);
    }

    // Audit the retention action + self-clean old audit entries
    try {
      logAudit(db, {
        timestamp: new Date().toISOString(),
        timestamp_epoch: Date.now(),
        session_id: sessionId,
        event_type: 'retention_cleanup',
        actor: 'hook:session-end',
        details: {
          observations: retentionResult.observationsDeleted,
          reasoning: retentionResult.reasoningDeleted,
          consensus: retentionResult.consensusDeleted,
        },
      });
      cleanOldAuditLogs(db, 30);
    } catch (auditErr) {
      logToFile(HOOK, 'WARN', 'Retention audit logging failed (non-fatal):', auditErr);
    }

    return true;
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 6 (retention policy) failed (non-fatal):', err);
    return false;
  }
}

/** Section 7a: Capture pressure scores from hologram sidecar */
async function runPressureCapture(
  db: import('better-sqlite3').Database,
  sessionId: string,
  scope: Scope,
  config: ClaudexConfig,
): Promise<boolean> {
  try {
    if (!config.hologram?.enabled) return false;

    try {
      const launcher = new SidecarManager();
      const protocol = new ProtocolHandler();
      const client = new HologramClient(launcher, protocol, config);

      if (!client.isAvailable()) {
        logToFile(HOOK, 'DEBUG', 'Hologram not available — skipping pressure capture');
        return false;
      }

      const response = await client.query('session-end', 0, sessionId);
      const allFiles = [...response.hot, ...response.warm, ...response.cold];
      const nowEpoch = Date.now();

      const scores = allFiles.map(file => ({
        file_path: file.path,
        project: scope.type === 'project' ? scope.name : undefined,
        raw_pressure: file.raw_pressure,
        temperature: file.temperature,
        last_accessed_epoch: nowEpoch,
        decay_rate: 0.05,
      }));

      batchUpsertPressureScores(db, scores);
      logToFile(HOOK, 'INFO', `Pressure scores captured from hologram: ${scores.length} files`);
      return true;
    } catch (hologramErr) {
      logToFile(HOOK, 'DEBUG', 'Hologram query for pressure capture failed (non-fatal)', hologramErr);
      return false;
    }
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 7a (pressure capture) failed (non-fatal):', err);
    return false;
  }
}

/** Section 7b: Write session summary to flat-file */
function runSessionSummary(
  sessionId: string,
  scope: Scope,
  cwd: string,
  reason: string,
  isoTimestamp: string,
  flags: {
    transcriptSaved: boolean;
    completionMarkerFound: boolean;
    failsafeWritten: boolean;
    sqliteUpdated: boolean;
    pressureCaptured: boolean;
  },
): boolean {
  try {
    const scopeStr = scope.type === 'project' ? `project:${scope.name}` : 'global';

    const summaryLines = [
      '---',
      `session_id: ${sessionId}`,
      `scope: ${scopeStr}`,
      `reason: ${reason}`,
      `started_at: unknown`,
      `ended_at: ${isoTimestamp}`,
      `transcript_saved: ${flags.transcriptSaved}`,
      `completion_marker: ${flags.completionMarkerFound}`,
      `failsafe_written: ${flags.failsafeWritten}`,
      `sqlite_updated: ${flags.sqliteUpdated}`,
      `pressure_captured: ${flags.pressureCaptured}`,
      '---',
      '',
      '# Session Summary',
      '',
      `Session \`${sessionId}\` ended at ${isoTimestamp}.`,
      `- **Scope**: ${scopeStr}`,
      `- **Reason**: ${reason}`,
      `- **CWD**: ${cwd}`,
      '',
    ];

    const sessionDirectory = sessionDir(sessionId);
    fs.mkdirSync(sessionDirectory, { recursive: true });

    const summaryPath = path.join(sessionDirectory, 'summary.md');
    fs.writeFileSync(summaryPath, summaryLines.join('\n'), 'utf-8');

    logToFile(HOOK, 'INFO', `Session summary written: ${summaryPath}`);
    return true;
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 7b (session summary) failed (non-fatal):', err);
    return false;
  }
}

/** Section 8: Decay pass -- stratified half-life decay on pressure scores */
function runDecayPass(
  db: import('better-sqlite3').Database,
  scope: Scope,
): { ran: boolean; count: number } {
  try {
    const project = scope.type === 'project' ? scope.name : undefined;
    const count = decayAllScores(db, project);
    if (count > 0) {
      logToFile(HOOK, 'INFO', `Decay pass: ${count} pressure scores updated`);
    }
    return { ran: true, count };
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 8 (decay pass) failed (non-fatal):', err);
    return { ran: false, count: 0 };
  }
}

/** Section 9: Observation pruning -- remove lowest-EI observations when >1000 */
function runObservationPruning(
  db: import('better-sqlite3').Database,
  scope: Scope,
): { ran: boolean; count: number } {
  try {
    const project = scope.type === 'project' ? scope.name : undefined;
    const result = pruneObservations(db, project);
    if (result.pruned > 0) {
      logToFile(HOOK, 'INFO', `Pruning: ${result.pruned} observations soft-deleted, ${result.remaining} remaining`);
    }
    return { ran: true, count: result.pruned };
  } catch (err) {
    logToFile(HOOK, 'WARN', 'Section 9 (observation pruning) failed (non-fatal):', err);
    return { ran: false, count: 0 };
  }
}

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

  // Load config once for the entire hook invocation
  const config = loadConfig();

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
    } else if (!transcript_path.endsWith('.jsonl') || !/[/\\]\.claude[/\\]|[/\\]sessions[/\\]/i.test(path.resolve(transcript_path))) {
      logToFile('session-end', 'WARN', `Transcript path failed validation (must be .jsonl in .claude/sessions): ${transcript_path}`);
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
        const STALE_LOCK_MS = 5000;
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
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
          logToFile('session-end', 'WARN', 'Could not acquire index.json lock, skipping index.json write to prevent corruption');
        }
      }

      if (releaseLock) {
        try {
          const raw = fs.readFileSync(indexPath, 'utf-8');
          const indexData = JSON.parse(raw) as {
            schema?: string;
            version?: number;
            sessions?: Array<Record<string, unknown>>;
          };

          if (Array.isArray(indexData.sessions)) {
            const matchingEntries = indexData.sessions.filter(
              (s) => s.id === session_id || s.session_id === session_id,
            );

            if (matchingEntries.length > 0) {
              const endedBy = completionMarkerFound ? 'endsession' : 'hook_failsafe';
              for (const entry of matchingEntries) {
                entry.status = 'completed';
                entry.ended_at = isoTimestamp;
                entry.ended_by = endedBy;
              }

              // Atomic write: temp file + rename
              const tmpPath = indexPath + `.tmp.${process.pid}`;
              fs.writeFileSync(tmpPath, JSON.stringify(indexData, null, 2) + '\n');
              fs.renameSync(tmpPath, indexPath);
              sessionIndexUpdated = true;
              logToFile('session-end', 'INFO',
                `Session index updated: ${matchingEntries.length} entries closed, ended_by=${endedBy}`);
            } else {
              logToFile('session-end', 'WARN',
                `Session ${session_id} not found in index.json`);
            }
          } else {
            logToFile('session-end', 'WARN', 'index.json sessions field is not an array');
          }
        } finally {
          releaseLock();
        }
      }
    } else {
      logToFile('session-end', 'WARN', `index.json does not exist: ${indexPath}`);
    }
  } catch (err) {
    logToFile('session-end', 'ERROR', 'Section 4 (session index update) failed:', err);
  }

  // =========================================================================
  // R25 fix: Open a single DB connection for all DB-dependent sections (5-9)
  // =========================================================================
  let db: import('better-sqlite3').Database | null = null;
  try {
    db = getDatabase();
    if (!db) {
      logToFile('session-end', 'WARN', 'Database connection failed — DB-dependent sections will be skipped');
    }
  } catch (dbErr) {
    logToFile('session-end', 'WARN', 'Database connection failed — DB-dependent sections will be skipped:', dbErr);
  }

  try {
    // Section 5: SQLite session update
    if (db) {
      sqliteUpdated = runSqliteUpdate(db, session_id, isoTimestamp);
    }

    // Section 6: Retention policy enforcement
    const retentionRan = db ? runRetentionPolicy(db, session_id, config) : false;

    // Section 7a: Pressure capture from hologram
    const pressureCaptured = db ? await runPressureCapture(db, session_id, scope, config) : false;

    // Section 7b: Write session summary
    const summaryCaptured = runSessionSummary(session_id, scope, cwd, reason, isoTimestamp, {
      transcriptSaved,
      completionMarkerFound,
      failsafeWritten,
      sqliteUpdated,
      pressureCaptured,
    });

    // Section 8: Decay pass
    const decay = db ? runDecayPass(db, scope) : { ran: false, count: 0 };

    // Section 9: Observation pruning
    const prune = db ? runObservationPruning(db, scope) : { ran: false, count: 0 };

    // Summary log
    logToFile(HOOK, 'INFO', [
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
      `  decayRan=${decay.ran} decayCount=${decay.count}`,
      `  pruneRan=${prune.ran} prunedCount=${prune.count}`,
    ].join('\n'));
  } finally {
    // R25: close the single shared DB connection
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  return {};
});
