/**
 * Claudex v2 — Hologram Client (WP-07)
 *
 * High-level API wrapping protocol + launcher for hook consumers.
 * Hooks call client.query(prompt) and get back scored files.
 */

import type { ClaudexConfig, HologramResponse, ScoredFile } from '../shared/types.js';
import { HologramError, HologramUnavailableError } from '../shared/errors.js';
import { createLogger } from '../shared/logger.js';
import { SidecarManager } from './launcher.js';
import { ProtocolHandler, buildRequest } from './protocol.js';

const log = createLogger('hologram-client');

/**
 * Classify a pressure bucket into a temperature tier.
 * Thresholds match hologram-cognitive's scoring pipeline exactly.
 */
export function classifyTemperature(pressureBucket: number): 'HOT' | 'WARM' | 'COLD' {
  if (pressureBucket >= 40) return 'HOT';   // raw >= 0.851
  if (pressureBucket >= 20) return 'WARM';  // raw >= 0.426
  return 'COLD';
}

export class HologramClient {
  constructor(
    private launcher: SidecarManager,
    private protocol: ProtocolHandler,
    private config: ClaudexConfig,
  ) {}

  /**
   * Query the attention engine for context scoring.
   *
   * Lazy-starts the sidecar if not running. Throws on unavailable sidecar
   * (WP-08 degradation layer catches this).
   */
  async query(prompt: string, turnNumber: number, sessionId: string): Promise<HologramResponse> {
    const port = await this.ensureSidecar();

    const request = buildRequest('query', {
      prompt,
      session_state: {
        turn_number: turnNumber,
        session_id: sessionId,
      },
    });

    const response = await this.protocol.send(port, request);

    if (response.type === 'error') {
      throw new HologramError(
        `Sidecar returned error: ${response.payload.error_message ?? 'unknown'}`,
      );
    }

    return this.buildHologramResponse(
      response.payload.hot ?? [],
      response.payload.warm ?? [],
      response.payload.cold ?? [],
    );
  }

  /**
   * Notify sidecar of file changes for edge recalculation.
   * Fire-and-forget: logs errors but does not throw.
   */
  async notifyFileChanges(files: string[]): Promise<void> {
    const port = this.launcher.getPort();
    if (port === null) {
      log.debug('Skipping file change notification — sidecar not running');
      return;
    }

    const request = buildRequest('update', { files_changed: files });

    try {
      await this.protocol.send(port, request);
    } catch (err) {
      log.warn('Failed to notify sidecar of file changes', err);
    }
  }

  /**
   * Health check. Returns true if the sidecar responds with pong within timeout.
   * Never throws.
   */
  async ping(): Promise<boolean> {
    try {
      const port = this.launcher.getPort();
      if (port === null) return false;

      const request = buildRequest('ping');
      const response = await this.protocol.send(port, request);
      return response.type === 'pong';
    } catch {
      return false;
    }
  }

  /**
   * Check if hologram sidecar is available (process alive + port file present).
   */
  isAvailable(): boolean {
    return this.launcher.isRunning();
  }

  /**
   * Ensure sidecar is running and return its port.
   * Lazy-starts if not running, respecting configured timeout.
   */
  private async ensureSidecar(): Promise<number> {
    let port = this.launcher.getPort();
    if (port !== null) return port;

    log.info('Sidecar not running, attempting lazy start');

    const timeoutMs = this.config.hologram?.timeout_ms ?? 2000;

    try {
      const startPromise = this.launcher.start();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new HologramUnavailableError('sidecar startup timed out')),
          timeoutMs,
        );
      });

      await Promise.race([startPromise, timeoutPromise]);
    } catch (err) {
      if (err instanceof HologramError) throw err;
      throw new HologramUnavailableError(
        `failed to start sidecar: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    port = this.launcher.getPort();
    if (port === null) {
      throw new HologramUnavailableError('sidecar started but port not available');
    }

    return port;
  }

  /**
   * Build a HologramResponse, ensuring each file has a temperature classification.
   * The sidecar may or may not include temperature — we always (re)classify from pressure_bucket.
   */
  private buildHologramResponse(
    hot: ScoredFile[],
    warm: ScoredFile[],
    cold: ScoredFile[],
  ): HologramResponse {
    const classify = (file: ScoredFile): ScoredFile => ({
      ...file,
      temperature: classifyTemperature(file.pressure_bucket),
    });

    return {
      hot: hot.map(classify),
      warm: warm.map(classify),
      cold: cold.map(classify),
    };
  }
}
