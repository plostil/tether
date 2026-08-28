/**
 * Tether rendezvous + signaling server entrypoint.
 *
 *   GET  /health            -> { ok, online }
 *   GET  /ice               -> ICE config (STUN + time-limited TURN creds)
 *   GET  /net-info          -> this machine's LAN addresses (for the pairing QR)
 *   GET  /*                 -> the built web client, when apps/web/dist exists
 *   WS   /signal            -> the broker (register / relay / watch)
 *
 * Run: `npm run dev -w apps/server`  (Node >= 22 for native TS; the server
 * implements its own WS transport, so it has no runtime dependencies).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
import { createBrokerServer, lanAddresses } from './server.ts';

const config = loadConfig();

// Serve the web client by default when it has been built (npm run build:web).
if (!config.webRoot) {
  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
  if (existsSync(join(dist, 'index.html'))) config.webRoot = dist;
}

const { server } = createBrokerServer(config);

server.listen(config.port, config.host, () => {
  console.log(
    `[tether] signaling on ws://${config.host}:${config.port}${config.signalPath} ` +
      `(health: /health, ice: /ice)`,
  );
  if (config.webRoot) {
    console.log(`[tether] web client: http://localhost:${config.port} (open this on the PC)`);
    for (const addr of lanAddresses()) {
      console.log(`[tether]             http://${addr}:${config.port} (reachable from the phone's Wi-Fi)`);
    }
  } else {
    console.log('[tether] web client not built — run `npm run build:web` to serve it here');
  }
  if (!config.turnUris.length) {
    console.log('[tether] no TURN configured — internet-relayed sessions will fail (SPEC §4); LAN is fine. Set TURN_URIS + TURN_SECRET.');
  }
});
