import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createBrokerServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { generateDeviceKeypair, PROTOCOL_VERSION } from '@tether/protocol';

/**
 * End-to-end test of the /ice gate over real HTTP + WebSocket: /ice is 401
 * without a session token and 200 with one issued at registration.
 */
test('/ice is gated behind the registration session token', async () => {
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1' };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  let ws: WebSocket | undefined;

  try {
    // Unauthenticated -> 401.
    const unauth = await fetch(`${base}/ice`);
    assert.equal(unauth.status, 401);

    // Register over WS, capture the session token.
    const kp = generateDeviceKeypair();
    const token = await new Promise<string>((resolve, reject) => {
      ws = new WebSocket(`ws://127.0.0.1:${port}/signal`);
      ws.addEventListener('error', () => reject(new Error('ws error')));
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(String(e.data));
        if (m.t === 'registered') resolve(m.sessionToken);
      });
      ws.addEventListener('open', () => {
        ws!.send(
          JSON.stringify({
            t: 'register',
            protocolVersion: PROTOCOL_VERSION,
            deviceId: kp.deviceId,
            publicKey: Buffer.from(kp.rawPublicKey).toString('base64'),
            capabilities: {},
          }),
        );
      });
    });

    // Bogus token -> still 401.
    const bogus = await fetch(`${base}/ice`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(bogus.status, 401);

    // Valid token -> 200 with ICE servers.
    const ok = await fetch(`${base}/ice`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as { iceServers: unknown[] };
    assert.ok(Array.isArray(body.iceServers) && body.iceServers.length >= 1);
  } finally {
    ws?.close();
    server.closeAllConnections?.();
    await new Promise<void>((res) => server.close(() => res()));
  }
});
