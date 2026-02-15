/**
 * Claudex v2 — Hologram Sidecar Protocol
 *
 * TCP/NDJSON transport for communicating with the hologram-cognitive Python sidecar.
 * Per-request connections: connect, send, receive, close.
 */

import * as net from 'node:net';
import * as crypto from 'node:crypto';
import type { SidecarRequest, SidecarResponse } from '../shared/types.js';
import {
  HologramError,
  HologramTimeoutError,
  HologramUnavailableError,
} from '../shared/errors.js';

export type { SidecarRequest, SidecarResponse };

export class ProtocolHandler {
  constructor(private readonly timeoutMs: number = 2000) {}

  async send(port: number, request: SidecarRequest): Promise<SidecarResponse> {
    return new Promise<SidecarResponse>((resolve, reject) => {
      let settled = false;
      let buffer = '';

      const socket = new net.Socket();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new HologramTimeoutError(this.timeoutMs));
        }
      }, this.timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
      };

      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err.code === 'ECONNREFUSED') {
          reject(new HologramUnavailableError(`connection refused on port ${port}`));
        } else {
          reject(new HologramError(`TCP error: ${err.message}`, err));
        }
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const newlineIdx = buffer.indexOf('\n');
        if (newlineIdx === -1) return; // partial read, keep buffering

        if (settled) return;
        settled = true;

        const line = buffer.slice(0, newlineIdx);
        cleanup();

        let response: SidecarResponse;
        try {
          response = JSON.parse(line) as SidecarResponse;
        } catch (err) {
          reject(new HologramError(`Malformed JSON from sidecar: ${line}`, err));
          return;
        }

        if (response.id !== request.id) {
          reject(
            new HologramError(
              `Response id mismatch: expected ${request.id}, got ${response.id}`,
            ),
          );
          return;
        }

        resolve(response);
      });

      socket.connect(port, '127.0.0.1', () => {
        const payload = JSON.stringify(request) + '\n';
        socket.write(payload);
      });
    });
  }
}

/**
 * Build a SidecarRequest with a fresh UUID.
 */
export function buildRequest(
  type: SidecarRequest['type'],
  payload: SidecarRequest['payload'] = {},
): SidecarRequest {
  return {
    id: crypto.randomUUID(),
    type,
    payload,
  };
}
