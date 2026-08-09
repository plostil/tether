/**
 * Live end-to-end check against a running server: exercises the actual RFC 6455
 * transport (not the in-memory broker). Run the server first, then:
 *   node apps/server/test/live-check.ts
 * Uses Node's built-in global WebSocket client (Node >= 22).
 */

import { generateDeviceKeypair, PROTOCOL_VERSION } from '@tether/protocol';

const PORT = process.env.PORT ?? '8080';
const BASE = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/signal`;

function open(kp: ReturnType<typeof generateDeviceKeypair>): Promise<{ ws: WebSocket; inbox: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    const inbox: any[] = [];
    ws.addEventListener('message', (e) => inbox.push(JSON.parse(String(e.data))));
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
      setTimeout(() => resolve({ ws, inbox }), 100);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const health = await (await fetch(`${BASE}/health`)).json();
  console.log('/health:', health);

  // /ice is gated now — without a session token it must be 401.
  const unauth = await fetch(`${BASE}/ice`);
  console.log('/ice without token ->', unauth.status, unauth.status === 401 ? '(gated ✓)' : '(UNEXPECTED)');

  const phone = generateDeviceKeypair();
  const pc = generateDeviceKeypair();
  const a = await open(phone);
  const b = await open(pc);

  const aRegistered = a.inbox.find((m) => m.t === 'registered');
  const bRegistered = b.inbox.find((m) => m.t === 'registered');
  if (!aRegistered || !bRegistered) throw new Error('registration failed');
  console.log('both registered ✓');

  // With the session token, /ice returns ICE servers.
  const iceRes = await fetch(`${BASE}/ice`, {
    headers: { authorization: `Bearer ${aRegistered.sessionToken}` },
  });
  if (iceRes.status !== 200) throw new Error(`/ice with token returned ${iceRes.status}`);
  const ice = (await iceRes.json()) as { iceServers: unknown[] };
  console.log(`/ice with token -> 200, ${ice.iceServers.length} iceServers ✓`);

  // phone relays an opaque blob to pc (this would be a Noise handshake message).
  a.ws.send(JSON.stringify({ t: 'relay', to: pc.deviceId, payload: 'aGVsbG8=' /* "hello" */ }));
  await sleep(150);

  const deliver = b.inbox.find((m) => m.t === 'deliver');
  if (!deliver) throw new Error('relay not delivered');
  if (deliver.from !== phone.deviceId) throw new Error('wrong from');
  if (Buffer.from(deliver.payload, 'base64').toString() !== 'hello') throw new Error('payload corrupted');
  console.log(`relay delivered ✓ (from ${deliver.from.slice(0, 8)}…, payload "hello")`);

  a.ws.close();
  b.ws.close();
  await sleep(50);
  console.log('LIVE CHECK PASSED');
  process.exit(0);
}

main().catch((e) => {
  console.error('LIVE CHECK FAILED:', e);
  process.exit(1);
});
