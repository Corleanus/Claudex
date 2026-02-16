/**
 * Claudex v2 — Hook Infrastructure
 *
 * Shared utilities for all hook entry points.
 * Underscore prefix signals this is NOT a hook entry point — esbuild
 * should not bundle it as a standalone output.
 *
 * Provides:
 *  - readStdin()  — parse JSON from stdin pipe
 *  - writeStdout() — emit JSON to stdout
 *  - runHook()    — harness that wires stdin→handler→stdout with error handling
 *  - logToFile()  — append timestamped lines to per-hook log files
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig } from '../shared/config.js';
import { recordMetric, getMetrics } from '../shared/metrics.js';
import { PATHS } from '../shared/paths.js';
import { detectVersion, migrateInput, stampOutput, validateInput } from '../shared/hook-schema.js';
import type { HookStdin, HookStdout } from '../shared/types.js';

/** Read JSON from stdin (piped by Claude Code). */
export async function readStdin<T>(): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return JSON.parse(raw) as T;
}

/** Write JSON to stdout (consumed by Claude Code). Optionally exit after flush. */
export function writeStdout(output: HookStdout, exitAfter?: boolean): void {
  const data = JSON.stringify(output) + '\n';
  if (exitAfter) {
    process.stdout.write(data, () => process.exit(0));
  } else {
    process.stdout.write(data);
  }
}

/**
 * Main hook runner — wraps a handler with stdin parsing, stdout emission,
 * and error handling. Calls process.exit(0) unconditionally so Node.js
 * does not hang on an open stdin fd.
 */
export async function runHook(
  hookName: string,
  handler: (input: HookStdin) => Promise<HookStdout>,
): Promise<void> {
  try {
    const rawInput = await readStdin<HookStdin>();

    // Schema versioning: detect, migrate, validate
    const version = detectVersion(rawInput as unknown as Record<string, unknown>);
    const input = migrateInput(rawInput as unknown as Record<string, unknown>, version) as unknown as HookStdin;
    const validation = validateInput(hookName, input as unknown as Record<string, unknown>, version);
    if (!validation.valid) {
      logToFile(hookName, 'WARN', `Input validation warnings: ${validation.errors.join(', ')}`);
    }

    const startMs = Date.now();
    let output: HookStdout;
    try {
      output = await handler(input);
    } catch (handlerError) {
      const endMs = Date.now();
      const durationMs = endMs - startMs;
      // Record metric with error flag — in its own try/catch so hook still succeeds
      try {
        recordMetric(`hook.${hookName}`, durationMs, true);
      } catch {
        // Metrics must never break the hook.
      }
      throw handlerError;
    }
    const endMs = Date.now();
    const durationMs = endMs - startMs;

    // Record success metric — isolated so failures don't break the hook
    try {
      recordMetric(`hook.${hookName}`, durationMs);
    } catch {
      // Metrics must never break the hook.
    }

    // Latency budget warning — isolated from hook execution
    try {
      const config = loadConfig();
      const latencyBudgetMs = config.hooks?.latency_budget_ms ?? 3000;
      if (durationMs > latencyBudgetMs) {
        logToFile(hookName, 'WARN', `Hook ${hookName} exceeded latency budget: ${durationMs}ms > ${latencyBudgetMs}ms`);
      }
    } catch {
      // Config/budget check must never break the hook.
    }

    // Session-end metrics dump
    if (hookName === 'session-end') {
      try {
        logToFile(hookName, 'INFO', 'Metrics dump:', getMetrics());
      } catch {
        // Metrics dump must never break the hook.
      }
    }

    // Stamp output with schema version
    writeStdout(stampOutput(output as unknown as Record<string, unknown>) as unknown as HookStdout, true);
  } catch (error) {
    logToFile(hookName, 'ERROR', error);
    try {
      // Stamp error outputs too — version info is always present
      writeStdout(stampOutput({}) as unknown as HookStdout, true);
    } catch {
      // stdout broken — exit directly
      process.exit(0);
    }
  }
}

/** Structured logging to per-hook log files in ~/.claudex/hooks/logs/. */
export function logToFile(hookName: string, level: string, ...args: unknown[]): void {
  try {
    const logDir = PATHS.hookLogs;
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logPath = path.join(logDir, `${hookName}.log`);
    const timestamp = new Date().toISOString();
    const message = args
      .map(a => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
        }
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');

    fs.appendFileSync(logPath, `[${timestamp}] [${level}] ${message}\n`);
  } catch {
    // Logging must never throw. Swallow silently.
  }
}
