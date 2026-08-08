/**
 * Tether rendezvous + signaling server entrypoint.
 *
 *   GET  /health            -> { ok, online }
 *   GET  /ice               -> ICE config (STUN + time-limited TURN creds)
 *   WS   /signal            -> the broker (register / relay / watch)
 *
 * Run: `npm run dev -w apps/server`  (Node >= 22 for native TS; the server
 * implements its own WS transport, so it has no runtime dependencies).
 */

import { loadConfig } from './config.ts';
import { createBrokerServer } from './server.ts';

const config = loadConfig();
const { server } = createBrokerServer(config);

server.listen(config.port, config.host, () => {
  console.log(
    `[tether] signaling on ws://${config.host}:${config.port}${config.signalPath} ` +
      `(health: /health, ice: /ice)`,
  );
  if (!config.turnUris.length) {
    console.log('[tether] no TURN configured — relayed sessions will fail (SPEC §4). Set TURN_URIS + TURN_SECRET.');
  }
});
