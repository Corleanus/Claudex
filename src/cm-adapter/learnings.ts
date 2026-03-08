/**
 * CM Adapter — Cross-Session Learnings
 *
 * Ported from OpenClaw Context Manager's context-learnings.ts.
 * Agent-scoped storage at ~/.echo/context/learnings/echo/learnings.json
 * with promotion counts, 50-entry cap, and fingerprint dedup.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeLearningFingerprint } from './fingerprint.js';
import { atomicWriteFile } from '../shared/fs-helpers.js';
import { ECHO_HOME, AGENT_ID, MAX_CROSS_SESSION_LEARNINGS } from './constants.js';
import type { CrossSessionLearningsStore } from './types.js';

function learningsDir(): string {
  return path.join(ECHO_HOME, 'context', 'learnings', AGENT_ID);
}

function learningsPath(): string {
  return path.join(learningsDir(), 'learnings.json');
}

const EMPTY_STORE: CrossSessionLearningsStore = { version: 1, max_entries: MAX_CROSS_SESSION_LEARNINGS, learnings: [] };

/** @internal Exported for testing */
export function validateLearningsStore(parsed: unknown): CrossSessionLearningsStore {
  if (
    parsed && typeof parsed === 'object' &&
    Array.isArray((parsed as any).learnings)
  ) {
    const store = parsed as CrossSessionLearningsStore;
    if (typeof store.max_entries !== 'number' || store.max_entries <= 0) {
      store.max_entries = MAX_CROSS_SESSION_LEARNINGS;
    }
    return store;
  }
  return { ...EMPTY_STORE, learnings: [] };
}

export async function readCrossSessionLearnings(): Promise<CrossSessionLearningsStore> {
  try {
    const raw = await fs.promises.readFile(learningsPath(), 'utf-8');
    return validateLearningsStore(JSON.parse(raw));
  } catch {
    return { ...EMPTY_STORE, learnings: [] };
  }
}

async function writeCrossSessionLearnings(store: CrossSessionLearningsStore): Promise<void> {
  const dir = learningsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  await atomicWriteFile(learningsPath(), JSON.stringify(store, null, 2));
}

/**
 * Promote in-session learnings to cross-session store.
 * Increments promotion_count for existing entries, adds new ones,
 * evicts oldest when over capacity.
 */
function applyPromotions(
  store: CrossSessionLearningsStore,
  learnings: Array<{ text: string; when: string }>,
  checkpointId: string,
  sessionId: string,
): void {
  const now = new Date().toISOString();

  // Build fingerprint index once for O(1) lookups
  const existingByFp = new Map<string, (typeof store.learnings)[number]>();
  for (const l of store.learnings) {
    existingByFp.set(normalizeLearningFingerprint(l.text), l);
  }

  for (const learning of learnings) {
    const fp = normalizeLearningFingerprint(learning.text);
    const existing = existingByFp.get(fp);

    if (existing) {
      if (existing.last_checkpoint_id === checkpointId) continue;
      existing.promotion_count++;
      existing.last_promoted_at = now;
      existing.last_checkpoint_id = checkpointId;
    } else {
      const entry = {
        id: crypto.randomUUID(),
        text: learning.text,
        source_session: sessionId,
        created_at: learning.when || now,
        last_promoted_at: now,
        promotion_count: 1,
        last_checkpoint_id: checkpointId,
      };
      store.learnings.push(entry);
      existingByFp.set(fp, entry);
    }
  }

  if (store.learnings.length > MAX_CROSS_SESSION_LEARNINGS) {
    store.learnings.sort(
      (a, b) => new Date(a.last_promoted_at).getTime() - new Date(b.last_promoted_at).getTime(),
    );
    store.learnings = store.learnings.slice(-MAX_CROSS_SESSION_LEARNINGS);
  }
}

const LOCK_STALE_MS = 10_000; // Locks older than 10s are considered stale

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    await fs.promises.writeFile(lockPath, `${process.pid}\n${Date.now()}`, {
      flag: 'wx', // Fail if file already exists
      encoding: 'utf-8',
    });
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'EEXIST') return false;

    // Check if existing lock is stale
    try {
      const content = await fs.promises.readFile(lockPath, 'utf-8');
      const timestamp = parseInt(content.split('\n')[1] ?? '0', 10);
      if (Date.now() - timestamp > LOCK_STALE_MS) {
        await fs.promises.unlink(lockPath).catch(() => {});
        // Retry once after removing stale lock
        try {
          await fs.promises.writeFile(lockPath, `${process.pid}\n${Date.now()}`, {
            flag: 'wx',
            encoding: 'utf-8',
          });
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      // Can't read lock file — treat as held
    }
    return false;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.promises.unlink(lockPath).catch(() => {});
}

export async function promoteLearnings(
  learnings: Array<{ text: string; when: string }>,
  checkpointId: string,
  sessionId: string,
): Promise<void> {
  const storePath = learningsPath();
  const lockPath = storePath + '.lock';

  const acquired = await acquireLock(lockPath);
  if (!acquired) {
    // Another process holds the lock — skip gracefully
    return;
  }

  try {
    const raw = await fs.promises.readFile(storePath, 'utf-8').catch(() => '');
    const store = validateLearningsStore(JSON.parse(raw || '{}'));

    applyPromotions(store, learnings, checkpointId, sessionId);
    await writeCrossSessionLearnings(store);
  } finally {
    await releaseLock(lockPath);
  }
}
