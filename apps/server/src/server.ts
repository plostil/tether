/**
 * Broker server factory — builds the HTTP + WebSocket signaling server WITHOUT
 * starting to listen. index.ts wraps this for the CLI; tests and the reference
 * demo use it to spin an ephemeral broker in-process.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { Broker } from './broker.ts';
import { attachWebSocket } from './ws.ts';
import { buildIceConfig } from './turn.ts';
import type { ServerConfig } from './config.ts';

/** IPv4 addresses the phone can reach this machine on (for the pairing QR). */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serve a file from webRoot; false if the path escapes it or doesn't exist. */
function serveStatic(webRoot: string, pathname: string, res: ServerResponse): boolean {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(join(webRoot, rel));
  const rootAbs = resolve(webRoot);
  if (file !== rootAbs && !file.startsWith(rootAbs + sep)) return false; // traversal guard
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
  return true;
}

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
    if (url.pathname === '/net-info') {
      // The web client cannot learn its own machine's LAN address; it needs it
      // to build the pairing URL for the phone. Addresses only — no secrets.
      json(res, 200, { lanAddresses: lanAddresses(), port: config.port });
      return;
    }
    if (config.webRoot && (req.method === 'GET' || req.method === 'HEAD')) {
      if (serveStatic(config.webRoot, url.pathname, res)) return;
    }
    json(res, 404, { error: 'not found' });
  });

  attachWebSocket(server, broker, config.signalPath);
  return { server, broker };
}
