/**
 * Claudex v2 — Structured Logging
 *
 * Writes timestamped log entries to ~/.claudex/hooks/logs/<name>.log.
 * Used by hooks for debugging and observability.
 * Never throws — logging failures are silently swallowed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PATHS } from './paths.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Create a logger for a specific hook or module.
 */
export function createLogger(name: string) {
  const logPath = path.join(PATHS.hookLogs, `${name}.log`);

  function log(level: LogLevel, ...args: unknown[]): void {
    try {
      // Ensure log directory exists
      const dir = path.dirname(logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

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

  return {
    debug: (...args: unknown[]) => log('DEBUG', ...args),
    info: (...args: unknown[]) => log('INFO', ...args),
    warn: (...args: unknown[]) => log('WARN', ...args),
    error: (...args: unknown[]) => log('ERROR', ...args),
  };
}
