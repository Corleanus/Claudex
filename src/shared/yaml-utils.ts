/**
 * Claudex v2 -- Shared YAML Utilities
 *
 * Consolidated YAML helpers extracted from state-files.ts and loader.ts (O01).
 * BOM stripping, CRLF normalization, safe load/write with JSON_SCHEMA.
 *
 * Never throws from public functions -- returns null on parse failure.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { createLogger } from './logger.js';

const log = createLogger('yaml-utils');

/**
 * Strip UTF-8 BOM and normalize CRLF before YAML parsing.
 * Handles all Windows line ending variants.
 */
export function normalizeYaml(raw: string): string {
  // Strip BOM (U+FEFF) -- appears at start of UTF-8 files on Windows
  let content = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  // Normalize CRLF -> LF
  content = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return content;
}

/**
 * Safely parse a YAML file. Returns null on any error (corrupt, missing, empty).
 * Uses JSON_SCHEMA to prevent type coercion (e.g., 'yes' -> true).
 */
export function safeLoadYaml(filePath: string): unknown {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) return null;
    const normalized = normalizeYaml(raw);
    return yaml.load(normalized, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    log.warn(`Failed to parse YAML: ${filePath}`, e);
    return null;
  }
}

/**
 * Safely write a YAML file. Creates parent directories if needed.
 * Uses JSON_SCHEMA for consistent serialization. Atomic write via temp+rename.
 */
export function safeWriteYaml(filePath: string, data: unknown): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const content = yaml.dump(data, {
      schema: yaml.JSON_SCHEMA,
      lineWidth: -1,        // No line wrapping
      noRefs: true,         // No YAML anchors/aliases
      sortKeys: false,      // Preserve insertion order
    });
    // Atomic write: write to temp file, then rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    log.error(`Failed to write YAML: ${filePath}`, e);
    // Clean up temp file on failure
    try { fs.unlinkSync(filePath + '.tmp'); } catch { /* ignore */ }
  }
}
