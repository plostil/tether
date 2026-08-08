/**
 * Tether rendezvous + signaling server entrypoint.
 *
 *   GET  /health            -> { ok, online }
 *   GET  /ice               -> ICE config (STUN + time-limited TURN creds)
 *   WS   /signal            -> the broker (register / relay / watch)
 *
 * Run: `npm run dev -w apps/server`  (needs Node >= 22 for native TS + WS client
 * is not required; the server implements its own WS transport).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Broker } from './broker.ts';
import { attachWebSocket } from './ws.ts';
import { loadConfig } from './config.ts';
import { buildIceConfig } from './turn.ts';

const config = loadConfig();
const broker = new Broker({
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  relayRatePerSec: config.relayRatePerSec,
});

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    json(res, 200, { ok: true, online: broker.onlineCount });
    return;
  }
  if (url.pathname === '/ice') {
    // In production, gate this behind the client's registration/session token.
    json(
      res,
      200,
      buildIceConfig({
        stunUris: config.stunUris,
        turnUris: config.turnUris,
        turnSecret: config.turnSecret,
        turnTtlSec: config.turnTtlSec,
      }),
    );
    return;
  }
  json(res, 404, { error: 'not found' });
});

attachWebSocket(server, broker, config.signalPath);

server.listen(config.port, config.host, () => {
  console.log(
    `[tether] signaling on ws://${config.host}:${config.port}${config.signalPath} ` +
      `(health: /health, ice: /ice)`,
  );
  if (!config.turnUris.length) {
    console.log('[tether] no TURN configured — relayed sessions will fail (SPEC §4). Set TURN_URIS + TURN_SECRET.');
  }
});
