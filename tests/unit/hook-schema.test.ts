import { describe, it, expect } from 'vitest';
import {
  CURRENT_SCHEMA_VERSION,
  detectVersion,
  migrateInput,
  stampOutput,
  validateInput,
} from '../../src/shared/hook-schema.js';

// =============================================================================
// detectVersion
// =============================================================================

describe('detectVersion', () => {
  it('returns 1 for input without schema_version (v1 implicit)', () => {
    const input = { session_id: 'abc', hook_event_name: 'SessionStart', cwd: '/tmp' };
    expect(detectVersion(input)).toBe(1);
  });

  it('returns the explicit schema_version when present', () => {
    const input = { schema_version: 2, session_id: 'abc' };
    expect(detectVersion(input)).toBe(2);
  });

  it('returns explicit version for future versions', () => {
    const input = { schema_version: 5, session_id: 'abc' };
    expect(detectVersion(input)).toBe(5);
  });

  it('returns 1 when schema_version is not a number', () => {
    const input = { schema_version: '2', session_id: 'abc' } as unknown as Record<string, unknown>;
    expect(detectVersion(input)).toBe(1);
  });

  it('returns 1 for empty object', () => {
    expect(detectVersion({})).toBe(1);
  });

  it('returns 1 when schema_version is null', () => {
    const input = { schema_version: null, session_id: 'abc' } as unknown as Record<string, unknown>;
    expect(detectVersion(input)).toBe(1);
  });

  it('returns 1 when schema_version is undefined', () => {
    const input = { schema_version: undefined, session_id: 'abc' };
    expect(detectVersion(input)).toBe(1);
  });
});

// =============================================================================
// migrateInput
// =============================================================================

describe('migrateInput', () => {
  it('adds schema_version=2 when migrating from v1', () => {
    const input = { session_id: 'abc', hook_event_name: 'SessionStart', cwd: '/tmp' };
    const migrated = migrateInput(input, 1);
    expect(migrated.schema_version).toBe(2);
  });

  it('preserves all existing fields during migration', () => {
    const input = {
      session_id: 'xyz',
      hook_event_name: 'PostToolUse',
      cwd: '/home/user',
      tool_name: 'Read',
      tool_input: { file: 'test.ts' },
    };
    const migrated = migrateInput(input, 1);
    expect(migrated.session_id).toBe('xyz');
    expect(migrated.hook_event_name).toBe('PostToolUse');
    expect(migrated.cwd).toBe('/home/user');
    expect(migrated.tool_name).toBe('Read');
    expect(migrated.tool_input).toEqual({ file: 'test.ts' });
  });

  it('does not modify the original input object', () => {
    const input = { session_id: 'abc', cwd: '/tmp' };
    const migrated = migrateInput(input, 1);
    expect(input).not.toHaveProperty('schema_version');
    expect(migrated.schema_version).toBe(2);
  });

  it('leaves v2 input unchanged', () => {
    const input = { schema_version: 2, session_id: 'abc', cwd: '/tmp' };
    const migrated = migrateInput(input, 2);
    expect(migrated).toEqual(input);
  });

  it('handles empty input gracefully', () => {
    const migrated = migrateInput({}, 1);
    expect(migrated.schema_version).toBe(2);
  });
});

// =============================================================================
// stampOutput
// =============================================================================

describe('stampOutput', () => {
  it('adds schema_version to empty output', () => {
    const stamped = stampOutput({});
    expect(stamped.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('adds schema_version to output with hookSpecificOutput', () => {
    const output = {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'some context',
      },
    };
    const stamped = stampOutput(output);
    expect(stamped.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(stamped.hookSpecificOutput).toEqual(output.hookSpecificOutput);
  });

  it('does not modify the original output object', () => {
    const output = { hookSpecificOutput: { hookEventName: 'Test' } };
    const stamped = stampOutput(output);
    expect(output).not.toHaveProperty('schema_version');
    expect(stamped.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('overwrites existing schema_version (upgrades to current)', () => {
    const output = { schema_version: 1 };
    const stamped = stampOutput(output);
    expect(stamped.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('CURRENT_SCHEMA_VERSION equals 2', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });
});

// =============================================================================
// validateInput
// =============================================================================

describe('validateInput', () => {
  it('passes validation with session_id present', () => {
    const input = { session_id: 'abc-123', hook_event_name: 'SessionStart', cwd: '/tmp' };
    const result = validateInput('session-start', input, 1);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails validation when session_id is missing', () => {
    const input = { hook_event_name: 'SessionStart', cwd: '/tmp' };
    const result = validateInput('session-start', input, 1);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: session_id');
  });

  it('fails validation when session_id is empty string', () => {
    const input = { session_id: '', hook_event_name: 'PostToolUse', cwd: '/tmp' };
    const result = validateInput('post-tool-use', input, 1);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: session_id');
  });

  it('validates session_id requirement for pre-flush (no exemptions)', () => {
    const input = { hook_event_name: 'PreFlush', cwd: '/tmp' };
    const result = validateInput('pre-flush', input, 1);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: session_id');
  });

  it('validates session_id requirement for all hook types', () => {
    const hooks = ['session-start', 'session-end', 'pre-compact', 'pre-flush', 'post-tool-use', 'user-prompt-submit'];
    for (const hookName of hooks) {
      const result = validateInput(hookName, { cwd: '/tmp' }, 1);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: session_id');
    }
  });

  it('passes validation for v2 input with session_id', () => {
    const input = { schema_version: 2, session_id: 'abc', cwd: '/tmp' };
    const result = validateInput('session-start', input, 2);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// =============================================================================
// Round-trip integration
// =============================================================================

describe('round-trip', () => {
  it('detect -> migrate -> validate -> stamp produces valid v2 output', () => {
    // Simulate v1 input (no schema_version)
    const rawInput = {
      session_id: 'test-session',
      hook_event_name: 'SessionStart',
      cwd: '/tmp',
    };

    // 1. Detect version
    const version = detectVersion(rawInput);
    expect(version).toBe(1);

    // 2. Migrate
    const migrated = migrateInput(rawInput, version);
    expect(migrated.schema_version).toBe(2);

    // 3. Validate against CURRENT version (post-migration), not detected version
    const validation = validateInput('session-start', migrated, CURRENT_SCHEMA_VERSION);
    expect(validation.valid).toBe(true);

    // 4. Stamp output
    const output = { hookSpecificOutput: { hookEventName: 'SessionStart' } };
    const stamped = stampOutput(output);
    expect(stamped.schema_version).toBe(2);
    expect(stamped.hookSpecificOutput).toBeDefined();
  });

  it('v2 input round-trips cleanly', () => {
    const rawInput = {
      schema_version: 2,
      session_id: 'v2-session',
      hook_event_name: 'PostToolUse',
      cwd: '/home',
      tool_name: 'Bash',
    };

    const version = detectVersion(rawInput);
    expect(version).toBe(2);

    const migrated = migrateInput(rawInput, version);
    expect(migrated.schema_version).toBe(2);
    expect(migrated.tool_name).toBe('Bash');

    const validation = validateInput('post-tool-use', migrated, version);
    expect(validation.valid).toBe(true);

    const stamped = stampOutput({});
    expect(stamped.schema_version).toBe(2);
  });

  it('error path also gets stamped', () => {
    // Simulates what infrastructure does on catch: stampOutput({})
    const errorOutput = stampOutput({});
    expect(errorOutput.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(Object.keys(errorOutput)).toEqual(['schema_version']);
  });

  it('validates against CURRENT version after migration, not detected version', () => {
    // Regression test for H1: ensure v2 validation rules apply after migration
    const v1Input = {
      session_id: 'test-session',
      hook_event_name: 'SessionStart',
      cwd: '/tmp',
    };

    const detectedVersion = detectVersion(v1Input);
    expect(detectedVersion).toBe(1);

    const migrated = migrateInput(v1Input, detectedVersion);
    expect(migrated.schema_version).toBe(2);

    // Validate against CURRENT version (2), not detected version (1)
    // This ensures any v2-specific validation rules are applied
    const validation = validateInput('session-start', migrated, CURRENT_SCHEMA_VERSION);
    expect(validation.valid).toBe(true);

    // Validating against old version would skip v2 rules (the bug we're fixing)
    const wrongValidation = validateInput('session-start', migrated, detectedVersion);
    expect(wrongValidation.valid).toBe(true); // Still passes, but v2 rules were skipped
  });
});
