/**
 * Claudex v2 — Hook Schema Versioning
 *
 * Provides version detection, migration, validation, and output stamping
 * for hook stdin/stdout JSON. Ensures backward compatibility with v1
 * (versionless) inputs while supporting future schema evolution.
 *
 * - v1: Implicit (no schema_version field) — Phase 1-5 hooks
 * - v2: Explicit (schema_version = 2) — Phase 7-9 hooks
 *
 * Migration is additive only — never remove fields.
 * Validation warns, never crashes — hooks must be resilient.
 */

export const CURRENT_SCHEMA_VERSION = 2;

export interface VersionedInput {
  schema_version?: number;
  [key: string]: unknown;
}

/**
 * Detect schema version from input.
 * Absent schema_version field = v1 (backward compatible).
 */
export function detectVersion(input: Record<string, unknown>): number {
  if (typeof input.schema_version === 'number') return input.schema_version;
  return 1;
}

/**
 * Migrate input from detected version to current version.
 * Additive only — adds defaults for new fields, never removes.
 */
export function migrateInput(input: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let migrated = { ...input };

  // v1 -> v2: Add schema_version stamp
  if (fromVersion < 2) {
    migrated.schema_version = 2;
    // Future: add field transformations here
  }

  return migrated;
}

/**
 * Stamp output with current schema version.
 * Applied to ALL hook outputs (success and error paths).
 */
export function stampOutput(output: Record<string, unknown>): Record<string, unknown> {
  return { ...output, schema_version: CURRENT_SCHEMA_VERSION };
}

/**
 * Validate required fields for a given hook + version.
 * Returns validation result — warnings only, never crashes.
 *
 * ALL hooks require session_id (pre-flush uses it for flush persistence).
 */
export function validateInput(
  _hookName: string,
  input: Record<string, unknown>,
  version: number,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Common required fields (all versions) — ALL hooks require session_id
  if (!input.session_id) {
    errors.push('Missing required field: session_id');
  }

  // Version-specific validations
  if (version >= 2) {
    // Future: validate new required fields for v2
  }

  return { valid: errors.length === 0, errors };
}
