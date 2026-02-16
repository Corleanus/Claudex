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

/** Step 3: Register session in index.json (append-only, v1 compatible). */
function registerInIndex(entry: SessionIndexEntry): void {
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
    fs.writeFileSync(PATHS.sessionIndex, JSON.stringify(index, null, 2), 'utf-8');
  } catch (err) {
    logToFile(HOOK_NAME, 'ERROR', 'Failed to register session in index.json', err);
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
  registerInIndex(entry);
  logToFile(HOOK_NAME, 'INFO', 'Session registered in index.json');

  // Step 4: SQLite registration (soft dependency)
  await registerInSqlite(scope, sessionId, cwd);

  // Step 4.5: Health check + Recovery
  try {
    const { loadConfig } = await import('../shared/config.js');
    const { checkHealth } = await import('../shared/health.js');
    const { getDatabase } = await import('../db/connection.js');
    const { runRecovery } = await import('../lib/recovery.js');

    const config = loadConfig();
    const db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping recovery and health check');
    } else {
      try {
        // Run recovery first — cleans up stale state before health check
        const recovery = await runRecovery(config, db);
        if (recovery.actionsPerformed.length > 0) {
          logToFile(HOOK_NAME, 'INFO', `Recovery: ${recovery.actionsPerformed.join(', ')}`);
        }

        const health = await checkHealth(config, db);
        health.recovery = recovery;
        logToFile(HOOK_NAME, 'INFO', `System health: ${JSON.stringify(health)}`);
      } finally {
        db.close();
      }
    }
  } catch (healthErr) {
    logToFile(HOOK_NAME, 'WARN', 'Health check / recovery failed (non-fatal)', healthErr);
  }

  // Step 5: First-run detection
  const isFirstRun = detectFirstRun();
  logToFile(HOOK_NAME, 'INFO', `First run: ${isFirstRun}`);

  // Step 6: Context restoration from DB
  let additionalContext: string | undefined;
  try {
    const { getDatabase } = await import('../db/connection.js');
    const { getRecentObservations } = await import('../db/observations.js');
    const { getRecentReasoning } = await import('../db/reasoning.js');
    const { getRecentConsensus } = await import('../db/consensus.js');
    const { getPressureScores } = await import('../db/pressure.js');
    const { assembleContext } = await import('../lib/context-assembler.js');
    const { loadConfig } = await import('../shared/config.js');

    const db = getDatabase();
    if (!db) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping context restoration');
    } else {
      try {
        // Query previous session state scoped appropriately:
        // - Project scope: query that project's data
        // - Global scope (project === null): query global-only data (WHERE project IS NULL or '__global__' sentinel)
        const observations = getRecentObservations(db, 20, project);
        const reasoningChains = getRecentReasoning(db, 5, project);
        const consensusDecisions = getRecentConsensus(db, 5, project);
        // Pressure scores use '__global__' sentinel instead of NULL due to UNIQUE constraint
        const pressureScores = getPressureScores(db, project ?? '__global__');

      logToFile(HOOK_NAME, 'DEBUG',
        `DB restoration data: observations=${observations.length} reasoning=${reasoningChains.length} consensus=${consensusDecisions.length} pressure=${pressureScores.length}`);

      // Build hologram-like response from DB pressure scores (fallback)
      // If hologram is available, query it instead
      let hologramResponse: import('../shared/types.js').HologramResponse | null = null;
      const config = loadConfig();

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
                const { upsertPressureScore } = await import('../db/pressure.js');
                const projectKey = project ?? '__global__';
                const nowEpoch = Date.now();

                const entries: Array<{ list: typeof hologramResponse.hot; temp: 'HOT' | 'WARM' | 'COLD'; pressure: number }> = [
                  { list: hologramResponse.hot, temp: 'HOT', pressure: 0.9 },
                  { list: hologramResponse.warm, temp: 'WARM', pressure: 0.5 },
                  { list: hologramResponse.cold, temp: 'COLD', pressure: 0.1 },
                ];

                let persisted = 0;
                for (const { list, temp, pressure } of entries) {
                  for (const file of list) {
                    upsertPressureScore(db, {
                      file_path: file.path,
                      project: projectKey,
                      raw_pressure: file.raw_pressure ?? pressure,
                      temperature: temp,
                      last_accessed_epoch: nowEpoch,
                      decay_rate: 0.05,
                    });
                    persisted++;
                  }
                }

                logToFile(HOOK_NAME, 'DEBUG', `Persisted ${persisted} hologram pressure scores to DB`);
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

      // Assemble context
      const assembled = assembleContext(sources, { maxTokens: 4000 });

      if (assembled.markdown.length > 0) {
        additionalContext = assembled.markdown;
        logToFile(HOOK_NAME, 'INFO',
          `Context restoration assembled: ${assembled.tokenEstimate} tokens, sources=[${assembled.sources.join(', ')}]`);
      } else {
        logToFile(HOOK_NAME, 'INFO', 'Context restoration: no restorable context found');
      }
      } finally {
        db.close();
      }
    }
  } catch (restorationErr) {
    logToFile(HOOK_NAME, 'WARN', 'Context restoration failed (non-fatal, continuing without restoration)', restorationErr);
  }

  // Step 6.5: Audit log — session restoration
  try {
    const { getDatabase: getAuditDb } = await import('../db/connection.js');
    const { logAudit } = await import('../db/audit.js');
    const auditDb = getAuditDb();
    if (!auditDb) {
      logToFile(HOOK_NAME, 'WARN', 'Database connection failed, skipping audit logging');
    } else {
      try {
        const auditNow = new Date();
        logAudit(auditDb, {
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
      } finally {
        auditDb.close();
      }
    }
  } catch (auditErr) {
    logToFile(HOOK_NAME, 'WARN', 'Audit logging failed (non-fatal)', auditErr);
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
