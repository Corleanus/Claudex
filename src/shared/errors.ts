/**
 * Claudex v2 — Error Types
 *
 * Typed errors for each subsystem. All extend ClaudexError.
 */

export class ClaudexError extends Error {
  constructor(
    message: string,
    public readonly subsystem: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ClaudexError';
  }
}

export class DatabaseError extends ClaudexError {
  constructor(message: string, cause?: unknown) {
    super(message, 'database', cause);
    this.name = 'DatabaseError';
  }
}

export class HologramError extends ClaudexError {
  constructor(message: string, cause?: unknown) {
    super(message, 'hologram', cause);
    this.name = 'HologramError';
  }
}

export class HologramTimeoutError extends HologramError {
  constructor(timeoutMs: number) {
    super(`Hologram sidecar did not respond within ${timeoutMs}ms`);
    this.name = 'HologramTimeoutError';
  }
}

export class HologramUnavailableError extends HologramError {
  constructor(reason: string) {
    super(`Hologram sidecar unavailable: ${reason}`);
    this.name = 'HologramUnavailableError';
  }
}

export class HookError extends ClaudexError {
  constructor(hookName: string, message: string, cause?: unknown) {
    super(`[${hookName}] ${message}`, 'hook', cause);
    this.name = 'HookError';
  }
}

export class ConfigError extends ClaudexError {
  constructor(message: string, cause?: unknown) {
    super(message, 'config', cause);
    this.name = 'ConfigError';
  }
}
