/**
 * Claudex v2 — Scope Detector
 *
 * Canonical scope detection algorithm shared by all hooks.
 * Determines whether cwd falls within a registered project or is global scope.
 * Never throws — returns global scope on any error.
 */

import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { createLogger } from './logger.js';
import type { Scope, ProjectsRegistry } from './types.js';

const log = createLogger('scope-detector');

/**
 * Normalize a filesystem path for comparison.
 * Converts backslashes to forward slashes, strips trailing slashes, lowercases.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Detect the scope for a given working directory.
 *
 * Algorithm:
 * 1. Read ~/.claudex/projects.json
 * 2. Normalize cwd
 * 3. For each project in the registry, check if cwd is within the project path
 * 4. Return project scope on match, global scope otherwise
 * 5. On any error (missing file, corrupt JSON), return global scope
 */
export function detectScope(cwd: string): Scope {
  try {
    const raw = fs.readFileSync(PATHS.projects, 'utf-8');
    let data: ProjectsRegistry;

    try {
      data = JSON.parse(raw) as ProjectsRegistry;
    } catch (e) {
      log.warn('Corrupt projects.json, falling back to global scope', e);
      return { type: 'global' };
    }

    if (!data.projects || typeof data.projects !== 'object') {
      log.warn('projects.json missing "projects" object, falling back to global scope');
      return { type: 'global' };
    }

    const normalizedCwd = normalizePath(cwd);

    for (const projectName of Object.keys(data.projects)) {
      const entry = data.projects[projectName];
      if (!entry || !entry.path) continue;

      const normalizedProjectPath = normalizePath(entry.path);

      if (
        normalizedCwd === normalizedProjectPath ||
        normalizedCwd.startsWith(normalizedProjectPath + '/')
      ) {
        return { type: 'project', name: projectName, path: entry.path };
      }
    }

    return { type: 'global' };
  } catch {
    // Missing projects.json or any filesystem error — global is the safe default
    return { type: 'global' };
  }
}
