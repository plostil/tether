import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createBrokerServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';
import { generateDeviceKeypair, PROTOCOL_VERSION } from '@tether/protocol';

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1' };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((res) => server.close(() => res()));
  }
}

/** Register over WS and resolve once the session token arrives. */
function registerWs(base: string, kp: ReturnType<typeof generateDeviceKeypair>): Promise<{ ws: WebSocket; token: string }> {
  const wsUrl = base.replace('http', 'ws') + '/signal';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.t === 'registered') resolve({ ws, token: m.sessionToken });
    });
    ws.addEventListener('error', reject);
    ws.addEventListener('open', () => {
      ws.send(
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
}

test('a host can mint a join code that resolves to its pair blob', async () => {
  await withServer(async (base) => {
    const kp = generateDeviceKeypair();
    const { ws, token } = await registerWs(base, kp);

    const mint = (await (await fetch(`${base}/pair-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })).json()) as { code: string; ttlSec: number };
    assert.match(mint.code, /^[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(mint.ttlSec, 600);

    const blob = (await (await fetch(`${base}/pair-code/${mint.code}`)).json()) as { id: string; key: string };
    assert.equal(blob.id, kp.deviceId);
    assert.equal(blob.key, Buffer.from(kp.rawPublicKey).toString('base64'));
    ws.close();
  });
});

test('minting without a session token is unauthorized', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/pair-code`, { method: 'POST' });
    assert.equal(r.status, 401);
  });
});

test('a code stops resolving after 3 lookups', async () => {
  await withServer(async (base) => {
    const kp = generateDeviceKeypair();
    const { ws, token } = await registerWs(base, kp);
    const { code } = (await (await fetch(`${base}/pair-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })).json()) as { code: string };
    for (let i = 0; i < 3; i++) {
      assert.equal((await fetch(`${base}/pair-code/${code}`)).status, 200);
    }
    assert.equal((await fetch(`${base}/pair-code/${code}`)).status, 404);
    ws.close();
  });
});

test('a code is gone once the host disconnects', async () => {
  await withServer(async (base) => {
    const kp = generateDeviceKeypair();
    const { ws, token } = await registerWs(base, kp);
    const { code } = (await (await fetch(`${base}/pair-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    })).json()) as { code: string };
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal((await fetch(`${base}/pair-code/${code}`)).status, 404);
  });
});

test('an unknown code is a 404', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/pair-code/ZZZZZZ`)).status, 404);
  });
});
