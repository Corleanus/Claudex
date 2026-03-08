/**
 * Claudex v2 — SessionStart Hook
 *
 * Fires on every session start (startup, resume, clear).
 * Bootstraps directory tree, detects scope, registers session,
 * and checks first-run status.
 *
 * NEVER throws — exits 0 always. Each step has independent error handling.
 */

import * as fs from 'node:fs';
import { runHook, logToFile } from './_infrastructure.js';
import { detectScope } from '../shared/scope-detector.js';
import { PATHS } from '../shared/paths.js';
import { loadLatestCheckpoint } from '../checkpoint/loader.js';
import { RESUME_LOAD } from '../checkpoint/types.js';
import type { LoadOptions } from '../checkpoint/types.js';
import { loadConfig } from '../shared/config.js';
import type { SessionStartInput, Scope, ContextSources, HookStdout } from '../shared/types.js';

const HOOK_NAME = 'session-start';

/** Directories to bootstrap on every invocation (idempotent). */
const BOOTSTRAP_DIRS = [
  PATHS.home,
  PATHS.identity,
  PATHS.memory,
  PATHS.memoryDaily,
  PATHS.memoryTopics,
  PATHS.sessions,
  PATHS.transcripts,
  PATHS.hooks,
  PATHS.hookLogs,
  PATHS.db,
];

/** Schema for index.json (v1 compatible). */
interface SessionIndex {
  schema: string;
  version: number;
  sessions: SessionIndexEntry[];
}

interface SessionIndexEntry {
  id: string;
  date: string;
  started_at: string;
  scope: string;
  project: string | null;
  cwd: string;
  source: string;
  status: string;
}

/** Convert Scope union to the string format used in index.json. */
function scopeToString(scope: Scope): string {
  return scope.type === 'project' ? `project:${scope.name}` : 'global';
}

/** Extract project name from scope, or null. */
function scopeToProject(scope: Scope): string | null {
  return scope.type === 'project' ? scope.name : null;
}

// =============================================================================
// Step implementations (each independently try/caught)
// =============================================================================

/** Step 1: Create ~/.claudex/ directory tree if missing. */
function bootstrapDirectories(): void {
  for (const dir of BOOTSTRAP_DIRS) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      logToFile(HOOK_NAME, 'WARN', `Failed to create directory: ${dir}`, err);
    }
  }
}

/** Stale lock threshold in milliseconds. */
const LOCK_STALE_MS = 5000;

/**
 * Acquire a file lock for index.json using an exclusive-create lock file.
 * Returns a release function. If the lock cannot be acquired, returns null.
 *
 * R26 fix: uses async setTimeout delay with exponential backoff instead of busy-wait.
 *
 * @internal — exported for testing
 */
export async function acquireIndexLock(): Promise<(() => void) | null> {
  const lockPath = PATHS.sessionIndex + '.lock';
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Exclusive create — fails if file already exists
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(Date.now()));
      fs.closeSync(fd);
      return () => {
        try { fs.unlinkSync(lockPath); } catch { /* already removed */ }
      };
    } catch {
      // Lock file exists — check if stale
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          // Stale lock — remove and retry
          try { fs.unlinkSync(lockPath); } catch { /* race with another cleanup */ }
          continue;
        }
      } catch {
        // Lock file disappeared between open and stat — retry
        continue;
      }

      // Lock is held and not stale — wait with exponential backoff before retry
      if (attempt < maxRetries - 1) {
        const retryDelay = 50 * Math.pow(2, attempt); // 50ms, 100ms, 200ms
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  return null;
}

/** Step 3: Register session in index.json (append-only, v1 compatible). */
async function registerInIndex(entry: SessionIndexEntry): Promise<void> {
  const releaseLock = await acquireIndexLock();
  if (!releaseLock) {
    logToFile(HOOK_NAME, 'WARN', 'Could not acquire index.json lock, skipping index.json write to prevent corruption');
    return;
  }

  try {
    let index: SessionIndex;

    if (fs.existsSync(PATHS.sessionIndex)) {
      const raw = fs.readFileSync(PATHS.sessionIndex, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      // Handle both v1 PS format and TS format. Guard against
      // sessions not being an array (PS single-element quirk).
      if (
        typeof parsed === 'object' && parsed !== null &&
        'sessions' in parsed
      ) {
        const data = parsed as { schema?: string; version?: number; sessions: unknown };
        const sessions = Array.isArray(data.sessions) ? data.sessions as SessionIndexEntry[] : [];
        index = {
          schema: data.schema ?? 'claudex/session-index',
          version: data.version ?? 1,
          sessions,
        };
      } else {
        // Unrecognized format — start fresh but preserve the file
        logToFile(HOOK_NAME, 'WARN', 'index.json has unexpected shape, resetting sessions array');
        index = { schema: 'claudex/session-index', version: 1, sessions: [] };
      }
    } else {
      index = { schema: 'claudex/session-index', version: 1, sessions: [] };
    }

    index.sessions.push(entry);

    // Atomic write: write to PID-unique temp file, then rename to prevent corruption
    const tmpPath = PATHS.sessionIndex + `.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8');
    fs.renameSync(tmpPath, PATHS.sessionIndex);
  } catch (err) {
    logToFile(HOOK_NAME, 'ERROR', 'Failed to register session in index.json', err);
  } finally {
    if (releaseLock) releaseLock();
  }
}

/** Step 4: Register session in SQLite (soft dependency — skip if unavailable). */
async function registerInSqlite(scope: Scope, sessionId: string, cwd: string): Promise<void> {
  try {
    const { getDatabase } = await import('../db/connection.js');
    const { createSession } = await import('../db/sessions.js');

    const db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping session creation');
    } else {
      try {
        const result = createSession(db, {
          session_id: sessionId,
          scope: scopeToString(scope),
          project: scopeToProject(scope) ?? undefined,
          cwd,
        });

        if (result.id === -1) {
          logToFile(HOOK_NAME, 'WARN', 'SQLite createSession returned error sentinel');
        } else {
          logToFile(HOOK_NAME, 'INFO', `Session registered in SQLite (rowid=${result.id})`);
        }
      } finally {
        db.close();
      }
    }
  } catch (err) {
    logToFile(HOOK_NAME, 'WARN', 'SQLite unavailable, skipping DB registration (Tier 2 degradation)', err);
  }
}

/** Step 5: Check if this is a first run. */
function detectFirstRun(): boolean {
  try {
    if (!fs.existsSync(PATHS.bootstrapMd)) {
      return false;
    }
    if (!fs.existsSync(PATHS.userMd)) {
      return false;
    }
    const userContent = fs.readFileSync(PATHS.userMd, 'utf-8');
    return userContent.includes('(to be filled during bootstrap)');
  } catch {
    return false;
  }
}

// =============================================================================
// Main hook
// =============================================================================

runHook(HOOK_NAME, async (input) => {
  const startInput = input as SessionStartInput;
  const sessionId = startInput.session_id || 'unknown';
  const cwd = startInput.cwd || process.cwd();
  const source = startInput.source || 'unknown';

  // Load config once for the entire hook invocation
  const config = loadConfig();

  // Step 1: Bootstrap directories
  bootstrapDirectories();
  logToFile(HOOK_NAME, 'INFO', 'Directories bootstrapped');

  // Step 2: Scope detection
  const scope = detectScope(cwd);
  const scopeStr = scopeToString(scope);
  const project = scopeToProject(scope);
  logToFile(HOOK_NAME, 'INFO', `Scope detected: ${scopeStr}`);

  // Step 3: Register in index.json
  const now = new Date();
  const entry: SessionIndexEntry = {
    id: sessionId,
    date: now.toISOString().split('T')[0]!,
    started_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    scope: scopeStr,
    project,
    cwd,
    source,
    status: 'active',
  };
  await registerInIndex(entry);
  logToFile(HOOK_NAME, 'INFO', 'Session registered in index.json');

  // Step 4: SQLite registration (soft dependency)
  await registerInSqlite(scope, sessionId, cwd);

  // Open a single DB connection for Steps 4.5, 6, and 6.5
  let db: import('better-sqlite3').Database | null = null;
  try {
    const { getDatabase } = await import('../db/connection.js');
    db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed — DB-dependent steps will run degraded');
    }
  } catch (dbErr) {
    logToFile(HOOK_NAME, 'WARN', 'Database connection failed — DB-dependent steps will run degraded', dbErr);
  }

  // Step 5: First-run detection (does not depend on DB)
  const isFirstRun = detectFirstRun();
  logToFile(HOOK_NAME, 'INFO', `First run: ${isFirstRun}`);

  let additionalContext: string | undefined;

  try {
  // Step 4.5: Health check + Recovery
  if (db) {
    try {
      const { checkHealth } = await import('../shared/health.js');
      const { runRecovery } = await import('../lib/recovery.js');

      // Run recovery first — cleans up stale state before health check
      const recovery = await runRecovery(config, db);
      if (recovery.actionsPerformed.length > 0) {
        logToFile(HOOK_NAME, 'INFO', `Recovery: ${recovery.actionsPerformed.join(', ')}`);
      }

      const health = await checkHealth(config, db);
      health.recovery = recovery;
      logToFile(HOOK_NAME, 'INFO', `System health: ${JSON.stringify(health)}`);
    } catch (healthErr) {
      logToFile(HOOK_NAME, 'WARN', 'Health check / recovery failed (non-fatal)', healthErr);
    }
  }

  // Step 6: Context restoration from DB
  if (db) {
    try {
      const { getRecentObservations } = await import('../db/observations.js');
      const { getRecentReasoning } = await import('../db/reasoning.js');
      const { getRecentConsensus } = await import('../db/consensus.js');
      const { getPressureScores } = await import('../db/pressure.js');
      const { assembleContext } = await import('../lib/context-assembler.js');

      // Query previous session state scoped appropriately:
      // - Project scope: query that project's data
      // - Global scope (project === null): query global-only data (DB handles undefined/null as global scope)
      const observations = getRecentObservations(db, 20, project);
      const reasoningChains = getRecentReasoning(db, 5, project);
      const consensusDecisions = getRecentConsensus(db, 5, project);
      // Pressure scores: undefined maps to __global__ sentinel internally (UNIQUE constraint)
      const pressureScores = getPressureScores(db, project ?? undefined);

      logToFile(HOOK_NAME, 'DEBUG',
        `DB restoration data: observations=${observations.length} reasoning=${reasoningChains.length} consensus=${consensusDecisions.length} pressure=${pressureScores.length}`);

      // Build hologram-like response from DB pressure scores (fallback)
      // If hologram is available, query it instead
      let hologramResponse: import('../shared/types.js').HologramResponse | null = null;

      if (config.hologram?.enabled) {
        try {
          const { HologramClient } = await import('../hologram/client.js');
          const { SidecarManager } = await import('../hologram/launcher.js');
          const { ProtocolHandler } = await import('../hologram/protocol.js');

          const launcher = new SidecarManager();
          const protocol = new ProtocolHandler();
          const client = new HologramClient(launcher, protocol, config);

          if (client.isAvailable()) {
            hologramResponse = await client.query('session-start', 0, sessionId);
            logToFile(HOOK_NAME, 'DEBUG', 'Hologram sidecar responded with scores');

            // Persist hologram pressure scores to DB so wrapper/pre-flush sees fresh data
            if (hologramResponse) {
              try {
                const { batchUpsertPressureScores } = await import('../db/pressure.js');
                const projectKey = project ?? undefined;
                const nowEpoch = Date.now();

                const entries: Array<{ list: typeof hologramResponse.hot; temp: 'HOT' | 'WARM' | 'COLD'; pressure: number }> = [
                  { list: hologramResponse.hot, temp: 'HOT', pressure: 0.9 },
                  { list: hologramResponse.warm, temp: 'WARM', pressure: 0.5 },
                  { list: hologramResponse.cold, temp: 'COLD', pressure: 0.1 },
                ];

                const scores: Array<{ file_path: string; project?: string; raw_pressure: number; temperature: 'HOT' | 'WARM' | 'COLD'; last_accessed_epoch: number; decay_rate: number }> = [];
                for (const { list, temp, pressure } of entries) {
                  for (const file of list) {
                    scores.push({
                      file_path: file.path,
                      project: projectKey,
                      raw_pressure: file.raw_pressure ?? pressure,
                      temperature: temp,
                      last_accessed_epoch: nowEpoch,
                      decay_rate: 0.05,
                    });
                  }
                }

                batchUpsertPressureScores(db, scores);
                logToFile(HOOK_NAME, 'DEBUG', `Persisted ${scores.length} hologram pressure scores to DB`);
              } catch (persistErr) {
                logToFile(HOOK_NAME, 'WARN', 'Failed to persist hologram pressure scores (non-fatal)', persistErr);
              }
            }
          } else {
            logToFile(HOOK_NAME, 'DEBUG', 'Hologram sidecar not available, using DB pressure scores as fallback');
          }
        } catch (hologramErr) {
          logToFile(HOOK_NAME, 'DEBUG', 'Hologram query failed, falling back to DB pressure scores', hologramErr);
        }
      }

      // If hologram unavailable, build scored files from DB pressure scores
      if (!hologramResponse && pressureScores.length > 0) {
        const hot = pressureScores
          .filter(s => s.temperature === 'HOT')
          .map(s => ({
            path: s.file_path,
            raw_pressure: s.raw_pressure,
            temperature: 'HOT' as const,
            system_bucket: 0,
            pressure_bucket: Math.round(s.raw_pressure * 47),
          }));
        const warm = pressureScores
          .filter(s => s.temperature === 'WARM')
          .map(s => ({
            path: s.file_path,
            raw_pressure: s.raw_pressure,
            temperature: 'WARM' as const,
            system_bucket: 0,
            pressure_bucket: Math.round(s.raw_pressure * 47),
          }));
        const cold = pressureScores
          .filter(s => s.temperature === 'COLD')
          .map(s => ({
            path: s.file_path,
            raw_pressure: s.raw_pressure,
            temperature: 'COLD' as const,
            system_bucket: 0,
            pressure_bucket: Math.round(s.raw_pressure * 47),
          }));

        hologramResponse = { hot, warm, cold };
        logToFile(HOOK_NAME, 'DEBUG',
          `Built hologram fallback from DB: hot=${hot.length} warm=${warm.length} cold=${cold.length}`);
      }

      // Step 5.8: Load checkpoint for resume context
      let checkpointMarkdown: string | undefined;
      let checkpointTokens = 0;
      try {
        const projectDir = scope.type === 'project' ? scope.path : PATHS.home;
        const loadOptions: LoadOptions = {
          sections: [...RESUME_LOAD],
          resumeMode: true,
        };
        const loaded = loadLatestCheckpoint(projectDir, loadOptions);
        if (loaded) {
          checkpointMarkdown = loaded.markdown;
          checkpointTokens = loaded.tokenEstimate;
          logToFile(HOOK_NAME, 'INFO', `Checkpoint loaded: sections=[${loaded.loadedSections.join(',')}] ~${loaded.tokenEstimate} tokens${loaded.recoveryPath ? ` (recovery: ${loaded.recoveryPath})` : ''}`);
        }
      } catch (cpErr) {
        logToFile(HOOK_NAME, 'WARN', 'Checkpoint loading failed (non-fatal)', cpErr);
      }

      // Build ContextSources
      const sources: ContextSources = {
        hologram: hologramResponse,
        searchResults: [],
        recentObservations: observations,
        reasoningChains,
        consensusDecisions,
        scope,
        postCompaction: false,
      };

      // Assemble context — reduce budget by checkpoint tokens to stay within 4000 total
      const assemblerBudget = Math.max(1000, 4000 - checkpointTokens);
      const assembled = assembleContext(sources, { maxTokens: assemblerBudget });

      // Combine: checkpoint first (high priority resume state), then DB context
      const parts: string[] = [];
      if (checkpointMarkdown) parts.push(checkpointMarkdown.trimEnd());
      if (assembled.markdown.length > 0) parts.push(assembled.markdown.trimEnd());

      if (parts.length > 0) {
        additionalContext = parts.join('\n\n');
        const allSources = [...(checkpointMarkdown ? ['checkpoint'] : []), ...assembled.sources];
        const totalTokens = checkpointTokens + assembled.tokenEstimate;
        logToFile(HOOK_NAME, 'INFO',
          `Context restoration assembled: ~${totalTokens} tokens, sources=[${allSources.join(', ')}]`);
      } else {
        logToFile(HOOK_NAME, 'INFO', 'Context restoration: no restorable context found');
      }
    } catch (restorationErr) {
      logToFile(HOOK_NAME, 'WARN', 'Context restoration failed (non-fatal, continuing without restoration)', restorationErr);
    }
  }

  // Step 6.5: Audit log — session restoration
  if (db) {
    try {
      const { logAudit } = await import('../db/audit.js');
      const auditNow = new Date();
      logAudit(db, {
        timestamp: auditNow.toISOString(),
        timestamp_epoch: auditNow.getTime(),
        session_id: sessionId,
        event_type: 'context_assembly',
        actor: 'hook:session-start',
        details: {
          restored: !!additionalContext,
          source,
        },
      });
    } catch (auditErr) {
      logToFile(HOOK_NAME, 'WARN', 'Audit logging failed (non-fatal)', auditErr);
    }
  }

  } finally {
    // Close the single shared DB connection
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  // Step 7: Final log summary
  logToFile(
    HOOK_NAME,
    'INFO',
    `=== SESSION START === id=${sessionId} cwd=${cwd} source=${source} scope=${scopeStr} project=${project ?? 'none'} firstRun=${isFirstRun} restored=${!!additionalContext}`,
  );

  // Build output
  const output: HookStdout = {};
  if (additionalContext) {
    output.hookSpecificOutput = {
      hookEventName: 'SessionStart',
      additionalContext,
    };
  }

  return output;
});
