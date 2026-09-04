/**
 * Reliability tests for the browser SecureLink, run in Node against a REAL
 * in-process WebSocket broker (createBrokerServer). Node 24 has global
 * WebSocket, so BrokerClient works unchanged; window/navigator are shimmed
 * minimally. These are the smoke alarms for the fixes in Stage 1: msg1 retry,
 * the handshake deadline, the self-pair guard, displacement, and reconnect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createBrokerServer } from '@tether/server';
import { loadConfig } from '@tether/server/config';
import { generateStaticKeypair, deviceIdFromPublicKey } from '@tether/protocol';
import { BrokerClient } from '../src/broker-client.ts';
import { SecureLink, type LinkState } from '../src/secure-link.ts';
import { browserCapabilities } from '../src/capabilities.ts';

// Minimal browser globals BrokerClient touches. `navigator` already exists in
// Node 24 (read-only), so only add `window` and `isSecureContext`.
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as any).isSecureContext = true;

const caps = browserCapabilities(null);

interface Server {
  url: string;
  close: () => Promise<void>;
  port: number;
}

async function startServer(port = 0): Promise<Server> {
  const config = { ...loadConfig(), port, host: '127.0.0.1' };
  const { server } = createBrokerServer(config);
  // Track raw TCP sockets (WebSocket upgrades start as 'connection') so we can
  // forcibly destroy them — mimicking real process death, where the OS drops
  // the sockets and clients reconnect. server.close() alone waits forever for
  // the open upgraded sockets.
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise<void>((res) => server.listen(port, '127.0.0.1', res));
  const actual = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${actual}/signal`,
    port: actual,
    close: () =>
      new Promise<void>((res) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => res());
      }),
  };
}

function makeClient(url: string, kp: ReturnType<typeof generateStaticKeypair>): BrokerClient {
  return new BrokerClient({
    serverUrl: url,
    staticKeypair: kp,
    deviceId: deviceIdFromPublicKey(kp.publicKey),
    capabilities: caps,
    reconnect: true,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('two links pair over the real broker and exchange messages both ways', { timeout: 12000 }, async () => {
  const s = await startServer();
  const pcKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(s.url, pcKp);
  const phoneClient = makeClient(s.url, phoneKp);

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
  await sleep(50);
  pc.send('hello-phone');
  await sleep(50);

  assert.deepEqual(pcInbox, ['hello-pc']);
  assert.deepEqual(phoneInbox, ['hello-phone']);
  assert.equal(phone.state, 'paired' as LinkState);
  assert.equal(pc.sessionFingerprint, phone.sessionFingerprint);

  pc.close();
  phone.close();
  pcClient.close();
  phoneClient.close();
  await s.close();
});

test('initiator that starts before the responder retries msg1 on peer online', { timeout: 12000 }, async () => {
  const s = await startServer();
  const pcKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(s.url, pcKp);
  const phoneClient = makeClient(s.url, phoneKp);

  const phone = new SecureLink(phoneClient, phoneKp, {
    role: 'initiator',
    peerDeviceId: pcClient.deviceId,
    peerStatic: pcKp.publicKey,
  });
  const pc = new SecureLink(pcClient, pcKp, { role: 'responder' });

  await phoneClient.connect();
  void phone.pair(); // watches; peer not online yet
  await sleep(150);
  await pcClient.connect();
  void pc.pair();

  await phone.pair(); // resolves once paired
  assert.equal(phone.state, 'paired');

  phone.close(); pc.close(); phoneClient.close(); pcClient.close();
  await s.close();
});

test('a wrong responder key makes the initiator time out (not hang)', { timeout: 12000 }, async () => {
  const s = await startServer();
  const pcKp = generateStaticKeypair();
  const wrongKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(s.url, pcKp);
  const phoneClient = makeClient(s.url, phoneKp);

  const pc = new SecureLink(pcClient, pcKp, { role: 'responder' });
  const phone = new SecureLink(phoneClient, phoneKp, {
    role: 'initiator',
    peerDeviceId: pcClient.deviceId,
    peerStatic: wrongKp.publicKey, // wrong: handshake cannot complete
    handshakeTimeoutMs: 400,
  });

  await Promise.all([pcClient.connect(), phoneClient.connect()]);
  void pc.pair();
  await assert.rejects(phone.pair(), /did not answer/);
  assert.equal(phone.state, 'failed');
  assert.equal(phone.fault?.kind, 'timeout');

  phone.close(); pc.close(); phoneClient.close(); pcClient.close();
  await s.close();
});

test('pairing with your own id is rejected as self-pair, not a silent hang', { timeout: 12000 }, async () => {
  const s = await startServer();
  const kp = generateStaticKeypair();
  const client = makeClient(s.url, kp);
  const link = new SecureLink(client, kp, {
    role: 'initiator',
    peerDeviceId: client.deviceId, // same identity
    peerStatic: kp.publicKey,
    handshakeTimeoutMs: 400,
  });
  await client.connect();
  await assert.rejects(link.pair(), /same device/);
  assert.equal(link.fault?.kind, 'self-pair');
  link.close(); client.close();
  await s.close();
});

test('a second client with the same identity displaces the first', { timeout: 12000 }, async () => {
  const s = await startServer();
  const kp = generateStaticKeypair();
  const a = makeClient(s.url, kp);
  const states: LinkState[] = [];
  a.on((e) => e.t === 'state' && states.push(e.state as LinkState));
  await a.connect();
  const b = makeClient(s.url, kp);
  await b.connect();
  await sleep(150);
  assert.equal(a.state, 'failed');
  assert.equal(a.fault?.kind, 'displaced');
  a.close(); b.close();
  await s.close();
});

test('a broker restart re-registers and re-pairs (degraded then paired)', { timeout: 22000 }, async () => {
  const s = await startServer();
  const port = s.port;
  const pcKp = generateStaticKeypair();
  const phoneKp = generateStaticKeypair();
  const pcClient = makeClient(s.url, pcKp);
  const phoneClient = makeClient(s.url, phoneKp);

  const pc = new SecureLink(pcClient, pcKp, { role: 'responder' });
  const phoneStates: LinkState[] = [];
  const phone = new SecureLink(phoneClient, phoneKp, {
    role: 'initiator',
    peerDeviceId: pcClient.deviceId,
    peerStatic: pcKp.publicKey,
    onEvent: (e) => e.t === 'state' && phoneStates.push(e.state),
  });

  await Promise.all([pcClient.connect(), phoneClient.connect()]);
  await Promise.all([pc.pair(), phone.pair()]);
  assert.equal(phone.state, 'paired');

  await s.close(); // drop everyone
  await sleep(200);
  assert.ok(phoneStates.includes('degraded'), 'went degraded after the drop');

  const s2 = await startServer(port); // same port
  // wait for reconnect + re-pair (reconnect backoff can take a few seconds)
  const deadline = Date.now() + 16000;
  while (phone.state !== 'paired' && Date.now() < deadline) await sleep(150);
  assert.equal(phone.state, 'paired', 're-paired after the broker came back');

  phone.close(); pc.close(); phoneClient.close(); pcClient.close();
  await s2.close();
});
