/**
 * Self-contained end-to-end demo (SPEC §4). Starts an in-process broker, pairs a
 * simulated phone (initiator) and PC (responder) over it with a real Noise_IK
 * handshake, and exchanges encrypted messages both ways — exercising the real
 * WebSocket transport and the zero-trust relay.
 *
 *   npm run demo -w apps/reference-cli
 */

import type { AddressInfo } from 'node:net';
import { createBrokerServer } from '@tether/server';
import { loadConfig } from '@tether/server/config';
import { generateStaticKeypair } from '@tether/protocol';
import { SecureLink } from './link.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const trace = (who: string) => (line: string) => console.log(`  [${who}] ${line}`);

async function main(): Promise<void> {
  // 1. Start an ephemeral broker in-process.
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1' };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  const url = `ws://127.0.0.1:${port}${config.signalPath}`;
  console.log(`broker listening on ${url}\n`);

  // 2. Two devices, each with an identity keypair (its Noise static key).
  const phoneKp = generateStaticKeypair();
  const pcKp = generateStaticKeypair();

  const pcInbox: string[] = [];
  const phoneInbox: string[] = [];

  const pc = new SecureLink({
    serverUrl: url,
    staticKeypair: pcKp,
    role: 'responder',
    log: trace('pc'),
    onMessage: (m) => pcInbox.push(m.toString()),
  });
  const phone = new SecureLink({
    serverUrl: url,
    staticKeypair: phoneKp,
    role: 'initiator',
    // Simulates the phone having scanned the PC's QR (its device id + static key).
    peerDeviceId: pc.deviceId,
    peerStatic: pcKp.publicKey,
    log: trace('phone'),
    onMessage: (m) => phoneInbox.push(m.toString()),
  });

  console.log(`phone id: ${phone.deviceId}`);
  console.log(`pc    id: ${pc.deviceId}\n`);

  // 3. Connect + register both.
  await Promise.all([pc.connect(), phone.connect()]);

  // 4. Pair (Noise_IK over the relay).
  console.log('\n-- pairing --');
  await Promise.all([pc.pair(), phone.pair()]);

  // 5. Exchange encrypted application messages.
  console.log('\n-- encrypted messages --');
  phone.send('unlock-session: phone→pc');
  await sleep(80);
  pc.send('ack: pc→phone');
  await sleep(80);

  console.log(`  pc received:    ${JSON.stringify(pcInbox)}`);
  console.log(`  phone received: ${JSON.stringify(phoneInbox)}`);

  const ok =
    pcInbox.length === 1 &&
    pcInbox[0] === 'unlock-session: phone→pc' &&
    phoneInbox.length === 1 &&
    phoneInbox[0] === 'ack: pc→phone';

  phone.close();
  pc.close();
  await new Promise<void>((res) => server.close(() => res()));

  console.log(ok ? '\n✅ DEMO PASSED' : '\n❌ DEMO FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('\n❌ DEMO ERROR:', e);
  process.exit(1);
});
