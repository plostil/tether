import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Broker, type Connection } from '../src/broker.ts';
import {
  NoiseHandshake,
  generateStaticKeypair,
  deviceIdFromPublicKey,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@tether/protocol';

/**
 * Full-stack proof: two devices pair over the real broker relay using a Noise_IK
 * handshake, then exchange an encrypted application message — and the PC verifies
 * the phone's authenticated Noise static key fingerprints to the phone's scanned
 * device ID. This ties together identity (§4), the zero-trust broker, and the
 * end-to-end session, exactly as the clients will.
 *
 * The broker only ever sees opaque base64 relay payloads; it never learns the
 * Noise keys or the plaintext.
 */

class RelayConn implements Connection {
  onDeliver: ((from: string, payload: Buffer) => void) | null = null;
  readonly id: string;
  private readonly broker: Broker;
  constructor(id: string, broker: Broker) {
    this.id = id;
    this.broker = broker;
  }
  send(msg: ServerMessage): void {
    if (msg.t === 'deliver') {
      this.onDeliver?.(msg.from, Buffer.from(msg.payload, 'base64'));
    }
  }
  close(): void {}
  relay(to: string, payload: Uint8Array): void {
    this.broker.onMessage(this, {
      t: 'relay',
      to,
      payload: Buffer.from(payload).toString('base64'),
    });
  }
}

function register(broker: Broker, conn: RelayConn, kp: ReturnType<typeof generateStaticKeypair>): string {
  const deviceId = deviceIdFromPublicKey(kp.publicKey);
  broker.onConnect(conn);
  broker.onMessage(conn, {
    t: 'register',
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    publicKey: Buffer.from(kp.publicKey).toString('base64'),
    capabilities: {},
  });
  return deviceId;
}

test('two devices pair over the broker relay and exchange an encrypted message', () => {
  const broker = new Broker();

  // A device's Noise static keypair IS its identity keypair (SPEC §4).
  const phoneKp = generateStaticKeypair();
  const pcKp = generateStaticKeypair();

  const phoneConn = new RelayConn('phone', broker);
  const pcConn = new RelayConn('pc', broker);
  const phoneId = register(broker, phoneConn, phoneKp);
  const pcId = register(broker, pcConn, pcKp);

  // The phone scanned the PC's QR, so it knows the PC's static key up front.
  const phone = NoiseHandshake.initiator(phoneKp, pcKp.publicKey);
  const pc = NoiseHandshake.responder(pcKp);

  let phoneTx: ReturnType<NoiseHandshake['split']> | null = null;
  let pcTx: ReturnType<NoiseHandshake['split']> | null = null;
  const decryptedOnPc: string[] = [];

  // Wire the relay: each side feeds delivered blobs into its handshake, then its
  // transport cipher once the handshake completes.
  pcConn.onDeliver = (from, payload) => {
    if (!pc.isComplete) {
      pc.readMessage(payload);
      // PC's identity check: does the phone's authenticated key match its ID?
      assert.equal(deviceIdFromPublicKey(pc.remoteStaticKey!), from);
      assert.equal(from, phoneId);
      const msg2 = pc.writeMessage();
      pcTx = pc.split();
      pcConn.relay(from, msg2);
    } else {
      decryptedOnPc.push(pcTx!.recv.decryptWithAd(new Uint8Array(0), payload).toString());
    }
  };

  phoneConn.onDeliver = (_from, payload) => {
    phone.readMessage(payload);
    phoneTx = phone.split();
    // Handshake done — send an encrypted application message to the PC.
    const ct = phoneTx.send.encryptWithAd(new Uint8Array(0), Buffer.from('unlock-session'));
    phoneConn.relay(pcId, ct);
  };

  // Kick off: phone sends handshake message 1 to the PC.
  phoneConn.relay(pcId, phone.writeMessage());

  assert.equal(phone.isComplete, true);
  assert.equal(pc.isComplete, true);
  assert.deepEqual(decryptedOnPc, ['unlock-session']);
});
