/**
 * The server-less transport: two SecureLinks pair over the in-tab LoopbackHub
 * exactly as they do over the WebSocket broker — same Noise_IK handshake, same
 * events, same fingerprint on both ends. This is what the hosted demo runs on,
 * so it gets the same smoke alarms as secure-link.test.ts: pairing both ways,
 * presence, and the initiator-before-responder retry.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStaticKeypair, deviceIdFromPublicKey } from '@tether/protocol';
import { LoopbackHub, LoopbackBrokerClient } from '../src/loopback.ts';
import { SecureLink, type LinkState } from '../src/secure-link.ts';
import { chooseTransport, clientFor } from '../src/app/transport.ts';
import { browserCapabilities } from '../src/capabilities.ts';

(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as any).isSecureContext = true;
(globalThis as any).location = { protocol: 'https:', host: 'plostil.github.io' };

const caps = browserCapabilities(null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeClient(hub: LoopbackHub, kp: ReturnType<typeof generateStaticKeypair>): LoopbackBrokerClient {
  return new LoopbackBrokerClient(hub, deviceIdFromPublicKey(kp.publicKey));
}

test('two links pair over the loopback hub and exchange messages both ways', { timeout: 8000 }, async () => {
  const hub = new LoopbackHub();
  const pcKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(hub, pcKp);
  const phoneClient = makeClient(hub, phoneKp);

  const pcInbox: string[] = [];
  const phoneInbox: string[] = [];
  const pc = new SecureLink(pcClient, pcKp, {
    role: 'responder',
    onEvent: (e) => e.t === 'message' && pcInbox.push(Buffer.from(e.plaintext).toString()),
  });
  const phone = new SecureLink(phoneClient, phoneKp, {
    role: 'initiator',
    peerDeviceId: pcClient.deviceId,
    peerStatic: pcKp.publicKey,
    onEvent: (e) => e.t === 'message' && phoneInbox.push(Buffer.from(e.plaintext).toString()),
  });

  await Promise.all([pcClient.connect(), phoneClient.connect()]);
  await Promise.all([pc.pair(), phone.pair()]);

  phone.send('hello-pc');
  await sleep(20);
  pc.send('hello-phone');
  await sleep(20);

  assert.deepEqual(pcInbox, ['hello-pc']);
  assert.deepEqual(phoneInbox, ['hello-phone']);
  assert.equal(phone.state, 'paired' as LinkState);
  assert.equal(pc.state, 'paired' as LinkState);
  assert.equal(pc.sessionFingerprint, phone.sessionFingerprint);
  assert.equal(pcClient.sessionToken, null, 'no /ice behind a static host');

  pc.close();
  phone.close();
  pcClient.close();
  phoneClient.close();
});

test('initiator that starts before the responder pairs once the peer registers', { timeout: 8000 }, async () => {
  const hub = new LoopbackHub();
  const pcKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(hub, pcKp);
  const phoneClient = makeClient(hub, phoneKp);

  const phone = new SecureLink(phoneClient, phoneKp, {
    role: 'initiator',
    peerDeviceId: pcClient.deviceId,
    peerStatic: pcKp.publicKey,
  });
  const pc = new SecureLink(pcClient, pcKp, { role: 'responder' });

  await phoneClient.connect();
  const pairing = phone.pair(); // watches; peer not online yet
  await sleep(50);
  await pcClient.connect();
  void pc.pair();

  await pairing;
  assert.equal(phone.state, 'paired' as LinkState);
  assert.equal(pc.sessionFingerprint, phone.sessionFingerprint);

  pc.close();
  phone.close();
  pcClient.close();
  phoneClient.close();
});

test('presence: a watcher sees the peer come and go', async () => {
  const hub = new LoopbackHub();
  const a = makeClient(hub, generateStaticKeypair());
  const b = makeClient(hub, generateStaticKeypair());
  const seen: boolean[] = [];
  a.on((e) => e.t === 'peer-status' && e.deviceId === b.deviceId && seen.push(e.online));

  await a.connect();
  a.watch(b.deviceId); // snapshot: offline
  await b.connect(); // transition: online
  b.close(); // transition: offline
  assert.deepEqual(seen, [false, true, false]);
  a.close();
});

test('chooseTransport: explicit broker wins, then forced/unreachable → loopback, else same-origin', () => {
  const explicit = chooseTransport({ brokerUrl: 'wss://x/signal', backend: false, forced: true });
  assert.deepEqual(explicit, { kind: 'ws', serverUrl: 'wss://x/signal' });

  assert.equal(chooseTransport({ brokerUrl: '', backend: true, forced: true }).kind, 'loopback');
  assert.equal(chooseTransport({ brokerUrl: '', backend: false, forced: false }).kind, 'loopback');

  const local = chooseTransport({ brokerUrl: '', backend: true, forced: false });
  assert.deepEqual(local, { kind: 'ws', serverUrl: 'wss://plostil.github.io/signal' });

  // Every client made for a loopback transport shares its hub.
  const t = chooseTransport({ brokerUrl: '', backend: false, forced: false });
  const kp = generateStaticKeypair();
  const c = clientFor(t, { staticKeypair: kp, deviceId: deviceIdFromPublicKey(kp.publicKey), capabilities: caps });
  assert.ok(c instanceof LoopbackBrokerClient);
});
