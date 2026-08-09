/**
 * Broker server factory — builds the HTTP + WebSocket signaling server WITHOUT
 * starting to listen. index.ts wraps this for the CLI; tests and the reference
 * demo use it to spin an ephemeral broker in-process.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Broker } from './broker.ts';
import { attachWebSocket } from './ws.ts';
import { buildIceConfig } from './turn.ts';
import type { ServerConfig } from './config.ts';

export function createBrokerServer(config: ServerConfig): { server: Server; broker: Broker } {
  const broker = new Broker({
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    relayRatePerSec: config.relayRatePerSec,
    sessionTtlMs: config.sessionTtlSec * 1000,
  });

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      json(res, 200, { ok: true, online: broker.onlineCount });
      return;
    }
    if (url.pathname === '/ice') {
      // Gated: caller must present a session token issued at registration, as
      // `Authorization: Bearer <sessionToken>`. Stops anonymous TURN abuse.
      const auth = req.headers['authorization'];
      const token =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
      const session = token ? broker.validateSession(token) : null;
      if (!session) {
        json(res, 401, {
          error: 'unauthorized',
          hint: 'register over /signal, then send Authorization: Bearer <sessionToken>',
        });
        return;
      }
      json(
        res,
        200,
        buildIceConfig({
          stunUris: config.stunUris,
          turnUris: config.turnUris,
          turnSecret: config.turnSecret,
          turnTtlSec: config.turnTtlSec,
          // Scope TURN creds to the device for attribution / per-device limits.
          userId: session.deviceId,
        }),
      );
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  attachWebSocket(server, broker, config.signalPath);
  return { server, broker };
}
