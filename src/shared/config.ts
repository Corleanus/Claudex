/**
 * Claudex v2 — Configuration Loading
 *
 * Loads ClaudexConfig from ~/.claudex/config.json.
 * Returns defaults when file is missing or corrupt.
 */

import * as fs from 'node:fs';
import { PATHS } from './paths.js';
import { type ClaudexConfig, DEFAULT_CONFIG } from './types.js';

/**
 * Load Claudex configuration.
 * Deep-merges file config over defaults. Missing or corrupt file → all defaults.
 */
export function loadConfig(): ClaudexConfig {
  try {
    if (!fs.existsSync(PATHS.config)) {
      return structuredClone(DEFAULT_CONFIG);
    }

    const raw = fs.readFileSync(PATHS.config, 'utf-8');
    const fileConfig = JSON.parse(raw) as Partial<ClaudexConfig>;

    return deepMerge(
      structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
      fileConfig as unknown as Record<string, unknown>,
    ) as ClaudexConfig;
  } catch {
    // Corrupt config file — use defaults silently
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Deep merge source into target. Source values override target values.
 * Only merges plain objects — arrays and primitives are replaced wholesale.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];

    if (
      sourceVal !== null &&
      sourceVal !== undefined &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === 'object' &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }

  return result;
}
