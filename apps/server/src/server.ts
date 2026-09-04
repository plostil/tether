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
import { PROTOCOL_VERSION } from '@tether/protocol';

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

/** Per-IP token bucket for join-code lookups, so 30 bits of code entropy
 *  cannot be brute-forced within a code's 10-minute lifetime. */
function makeLookupLimiter(perMin = 20): (ip: string) => boolean {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return (ip: string) => {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: perMin, last: now };
    b.tokens = Math.min(perMin, b.tokens + ((now - b.last) / 60_000) * perMin);
    b.last = now;
    buckets.set(ip, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

export function createBrokerServer(config: ServerConfig): { server: Server; broker: Broker } {
  const broker = new Broker({
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    relayRatePerSec: config.relayRatePerSec,
    sessionTtlMs: config.sessionTtlSec * 1000,
  });
  const allowLookup = makeLookupLimiter();

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/config') {
      // Public, non-secret runtime hints for the web client.
      json(res, 200, {
        demo: config.demo,
        signalPath: config.signalPath,
        protocolVersion: PROTOCOL_VERSION,
        turn: config.turnUris.length > 0,
      });
      return;
    }
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
    if (url.pathname === '/pair-code' && req.method === 'POST') {
      // Host mints a short join code. Requires the Bearer session token from
      // registration, so only a registered device can publish a code.
      const auth = req.headers['authorization'];
      const token =
        typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null;
      const made = token ? broker.createPairCode(token) : null;
      if (!made) {
        json(res, 401, { error: 'unauthorized', hint: 'register over /signal first' });
        return;
      }
      json(res, 200, made);
      return;
    }
    if (url.pathname.startsWith('/pair-code/') && req.method === 'GET') {
      const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
      if (!allowLookup(ip)) {
        json(res, 429, { error: 'rate-limited' });
        return;
      }
      const code = decodeURIComponent(url.pathname.slice('/pair-code/'.length));
      const blob = broker.resolvePairCode(code);
      if (!blob) {
        json(res, 404, { error: 'not-found', hint: 'code expired, used up, or wrong' });
        return;
      }
      json(res, 200, blob);
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
