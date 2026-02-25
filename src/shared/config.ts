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

    const merged = deepMerge(
      structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
      fileConfig as unknown as Record<string, unknown>,
    ) as ClaudexConfig;

    return validateConfig(merged);
  } catch {
    // Corrupt config file — use defaults silently
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * Validate and normalize config values.
 * Invalid values fall back to defaults from DEFAULT_CONFIG.
 */
function validateConfig(config: ClaudexConfig): ClaudexConfig {
  const defaults = DEFAULT_CONFIG;

  // Validate hologram
  if (config.hologram) {
    if (typeof config.hologram.enabled !== 'boolean') {
      config.hologram.enabled = defaults.hologram!.enabled;
    }
    if (typeof config.hologram.timeout_ms !== 'number' || config.hologram.timeout_ms < 0) {
      config.hologram.timeout_ms = defaults.hologram!.timeout_ms;
    }
    if (typeof config.hologram.health_interval_ms !== 'number' || config.hologram.health_interval_ms < 0) {
      config.hologram.health_interval_ms = defaults.hologram!.health_interval_ms;
    }
    if (config.hologram.python_path !== undefined && typeof config.hologram.python_path !== 'string') {
      delete config.hologram.python_path;
    }
    if (config.hologram.sidecar_path !== undefined && typeof config.hologram.sidecar_path !== 'string') {
      delete config.hologram.sidecar_path;
    }
    if (config.hologram.project_patterns !== undefined && !Array.isArray(config.hologram.project_patterns)) {
      config.hologram.project_patterns = defaults.hologram!.project_patterns;
    }
    if (config.hologram.project_exclude !== undefined && !Array.isArray(config.hologram.project_exclude)) {
      config.hologram.project_exclude = defaults.hologram!.project_exclude;
    }
    if (config.hologram.project_max_files !== undefined) {
      if (typeof config.hologram.project_max_files !== 'number' || config.hologram.project_max_files < 0) {
        config.hologram.project_max_files = defaults.hologram!.project_max_files;
      }
    }
  }

  // Validate database
  if (config.database) {
    if (typeof config.database.wal_mode !== 'boolean') {
      config.database.wal_mode = defaults.database!.wal_mode;
    }
    if (config.database.path !== undefined && typeof config.database.path !== 'string') {
      delete config.database.path;
    }
  }

  // Validate hooks
  if (config.hooks) {
    if (typeof config.hooks.latency_budget_ms !== 'number' || config.hooks.latency_budget_ms < 0) {
      config.hooks.latency_budget_ms = defaults.hooks!.latency_budget_ms;
    }
    if (config.hooks.context_token_budget !== undefined) {
      if (typeof config.hooks.context_token_budget !== 'number' || config.hooks.context_token_budget < 500 || config.hooks.context_token_budget > 50000) {
        delete config.hooks.context_token_budget;  // fall back to hardcoded default in hook
      }
    }
  }

  // Validate observation
  if (config.observation) {
    if (typeof config.observation.enabled !== 'boolean') {
      config.observation.enabled = defaults.observation!.enabled;
    }
    if (typeof config.observation.redact_secrets !== 'boolean') {
      config.observation.redact_secrets = defaults.observation!.redact_secrets;
    }
    if (config.observation.retention_days !== undefined) {
      if (typeof config.observation.retention_days !== 'number' || config.observation.retention_days < 0) {
        config.observation.retention_days = defaults.observation!.retention_days;
      }
    }
  }

  // Validate wrapper
  if (config.wrapper) {
    if (typeof config.wrapper.enabled !== 'boolean') {
      config.wrapper.enabled = defaults.wrapper!.enabled;
    }
    if (typeof config.wrapper.warnThreshold !== 'number' || config.wrapper.warnThreshold < 0 || config.wrapper.warnThreshold > 1) {
      config.wrapper.warnThreshold = defaults.wrapper!.warnThreshold;
    }
    if (typeof config.wrapper.flushThreshold !== 'number' || config.wrapper.flushThreshold < 0 || config.wrapper.flushThreshold > 1) {
      config.wrapper.flushThreshold = defaults.wrapper!.flushThreshold;
    }
    if (typeof config.wrapper.cooldownMs !== 'number' || config.wrapper.cooldownMs < 0) {
      config.wrapper.cooldownMs = defaults.wrapper!.cooldownMs;
    }
  }

  // Validate vector
  if (config.vector) {
    if (typeof config.vector.enabled !== 'boolean') {
      config.vector.enabled = defaults.vector!.enabled;
    }
    if (!['fts5', 'openai', 'local'].includes(config.vector.provider)) {
      config.vector.provider = defaults.vector!.provider;
    }
    if (config.vector.openai) {
      if (config.vector.openai.apiKey !== undefined && typeof config.vector.openai.apiKey !== 'string') {
        delete config.vector.openai.apiKey;
      }
      if (config.vector.openai.model !== undefined && typeof config.vector.openai.model !== 'string') {
        delete config.vector.openai.model;
      }
    }
  }

  return config;
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
