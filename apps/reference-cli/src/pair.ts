/**
 * Two-process reference client — pair against a running broker (SPEC §4).
 *
 *   # terminal 1: start the broker
 *   npm run dev -w apps/server
 *
 *   # terminal 2: responder (the "PC"). Prints a QR blob and waits.
 *   node apps/reference-cli/src/pair.ts responder
 *
 *   # terminal 3: initiator (the "phone"). Paste the responder's QR blob.
 *   node apps/reference-cli/src/pair.ts initiator <qr-blob> "hello from the phone"
 *
 * The QR blob is base64(JSON{ id, key }) — exactly what a real QR would carry.
 * Identities are ephemeral (generated per run); a real client persists them.
 */

import { generateStaticKeypair } from '@tether/protocol';
import { SecureLink } from './link.ts';

const SERVER_URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8080/signal';

interface Qr {
  id: string;
  key: string; // base64 raw X25519 public key
}

function encodeQr(id: string, publicKey: Uint8Array): string {
  const qr: Qr = { id, key: Buffer.from(publicKey).toString('base64') };
  return Buffer.from(JSON.stringify(qr)).toString('base64');
}

function decodeQr(blob: string): Qr {
  return JSON.parse(Buffer.from(blob, 'base64').toString()) as Qr;
}

async function runResponder(): Promise<void> {
  const kp = generateStaticKeypair();
  const link = new SecureLink({
    serverUrl: SERVER_URL,
    staticKeypair: kp,
    role: 'responder',
    log: (l) => console.log(`[responder] ${l}`),
    onMessage: (m) => console.log(`\n📥 message from peer: ${JSON.stringify(m.toString())}`),
  });

  await link.connect();
  console.log('\nShare this QR blob with the initiator:\n');
  console.log(`  ${encodeQr(link.deviceId, kp.publicKey)}\n`);
  await link.pair();
  console.log('\n🔐 paired. Waiting for messages (Ctrl+C to quit)…');
  // Keep the process alive.
  setInterval(() => {}, 1 << 30);
}

async function runInitiator(qrBlob: string, message: string): Promise<void> {
  const peer = decodeQr(qrBlob);
  const kp = generateStaticKeypair();
  const link = new SecureLink({
    serverUrl: SERVER_URL,
    staticKeypair: kp,
    role: 'initiator',
    peerDeviceId: peer.id,
    peerStatic: new Uint8Array(Buffer.from(peer.key, 'base64')),
    log: (l) => console.log(`[initiator] ${l}`),
    onMessage: (m) => console.log(`📥 reply from peer: ${JSON.stringify(m.toString())}`),
  });

  await link.connect();
  await link.pair();
  console.log(`\n🔐 paired. Sending: ${JSON.stringify(message)}`);
  link.send(message);
  await new Promise((r) => setTimeout(r, 500));
  link.close();
  process.exit(0);
}

const [role, ...rest] = process.argv.slice(2);
if (role === 'responder') {
  runResponder().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else if (role === 'initiator') {
  const qr = rest[0];
  if (!qr) {
    console.error('usage: pair.ts initiator <qr-blob> [message]');
    process.exit(2);
  }
  runInitiator(qr, rest[1] ?? 'hello from the initiator').catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  console.error('usage: pair.ts <responder|initiator> [...]');
  process.exit(2);
}
