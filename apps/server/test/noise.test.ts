import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NoiseHandshake,
  generateStaticKeypair,
  deviceIdFromPublicKey,
} from '@tether/protocol';

/** Drive a full IK handshake and return both parties' transport pairs. */
function runHandshake(
  initStatic = generateStaticKeypair(),
  respStatic = generateStaticKeypair(),
  opts: { initEph?: ReturnType<typeof generateStaticKeypair>; respEph?: ReturnType<typeof generateStaticKeypair>; msg1Payload?: Uint8Array; msg2Payload?: Uint8Array } = {},
) {
  const initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey, { ephemeral: opts.initEph });
  const responder = NoiseHandshake.responder(respStatic, { ephemeral: opts.respEph });

  const msg1 = initiator.writeMessage(opts.msg1Payload ?? new Uint8Array(0));
  const recvPayload1 = responder.readMessage(msg1);

  const msg2 = responder.writeMessage(opts.msg2Payload ?? new Uint8Array(0));
  const recvPayload2 = initiator.readMessage(msg2);

  return { initiator, responder, initStatic, respStatic, msg1, msg2, recvPayload1, recvPayload2 };
}

test('IK handshake completes and both sides derive matching transport keys', () => {
  const h = runHandshake();
  assert.equal(h.initiator.isComplete, true);
  assert.equal(h.responder.isComplete, true);

  const it = h.initiator.split();
  const rt = h.responder.split();

  // initiator.send <-> responder.recv
  const ct = it.send.encryptWithAd(new Uint8Array(0), Buffer.from('phone->pc'));
  assert.equal(rt.recv.decryptWithAd(new Uint8Array(0), ct).toString(), 'phone->pc');

  // responder.send <-> initiator.recv
  const ct2 = rt.send.encryptWithAd(new Uint8Array(0), Buffer.from('pc->phone'));
  assert.equal(it.recv.decryptWithAd(new Uint8Array(0), ct2).toString(), 'pc->phone');
});

test('handshake mutually authenticates static keys', () => {
  const h = runHandshake();
  // Responder learns the initiator's real static key...
  assert.deepEqual(Buffer.from(h.responder.remoteStaticKey!), Buffer.from(h.initStatic.publicKey));
  // ...and the initiator knew the responder's from the QR.
  assert.deepEqual(Buffer.from(h.initiator.remoteStaticKey!), Buffer.from(h.respStatic.publicKey));
});

test('the authenticated remote key fingerprints to the expected device id', () => {
  const h = runHandshake();
  // This is the check the app performs against the scanned QR device id (SPEC §4).
  const learnedId = deviceIdFromPublicKey(h.responder.remoteStaticKey!);
  const expectedId = deviceIdFromPublicKey(h.initStatic.publicKey);
  assert.equal(learnedId, expectedId);
});

test('both parties agree on the handshake (transcript) hash', () => {
  const h = runHandshake();
  assert.deepEqual(Buffer.from(h.initiator.handshakeHash), Buffer.from(h.responder.handshakeHash));
});

test('0-RTT-style payloads inside the handshake are delivered', () => {
  const h = runHandshake(undefined, undefined, {
    msg1Payload: Buffer.from('hello-from-initiator'),
    msg2Payload: Buffer.from('hello-from-responder'),
  });
  assert.equal(Buffer.from(h.recvPayload1).toString(), 'hello-from-initiator');
  assert.equal(Buffer.from(h.recvPayload2).toString(), 'hello-from-responder');
});

test('a tampered first message is rejected (authentication)', () => {
  const initStatic = generateStaticKeypair();
  const respStatic = generateStaticKeypair();
  const initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey);
  const responder = NoiseHandshake.responder(respStatic);

  const msg1 = Buffer.from(initiator.writeMessage());
  msg1[msg1.length - 1] ^= 0xff; // flip a byte in the encrypted payload
  assert.throws(() => responder.readMessage(msg1));
});

test('an initiator using the wrong responder static key fails the handshake', () => {
  const initStatic = generateStaticKeypair();
  const respStatic = generateStaticKeypair();
  const wrong = generateStaticKeypair();

  // Initiator was given the WRONG responder key (e.g. a MITM's key).
  const initiator = NoiseHandshake.initiator(initStatic, wrong.publicKey);
  const responder = NoiseHandshake.responder(respStatic);

  const msg1 = initiator.writeMessage();
  // Responder's DH results won't match -> decrypting the static key fails.
  assert.throws(() => responder.readMessage(msg1));
});

test('handshake is deterministic given fixed static and ephemeral keys (regression KAT)', () => {
  const initStatic = generateStaticKeypair();
  const respStatic = generateStaticKeypair();
  const initEph = generateStaticKeypair();
  const respEph = generateStaticKeypair();

  const a = runHandshake(initStatic, respStatic, { initEph, respEph });
  const b = runHandshake(initStatic, respStatic, { initEph, respEph });

  assert.deepEqual(Buffer.from(a.msg1), Buffer.from(b.msg1));
  assert.deepEqual(Buffer.from(a.msg2), Buffer.from(b.msg2));
  assert.deepEqual(Buffer.from(a.initiator.handshakeHash), Buffer.from(b.initiator.handshakeHash));
});

test('turn-order is enforced', () => {
  const initStatic = generateStaticKeypair();
  const respStatic = generateStaticKeypair();
  const initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey);
  const responder = NoiseHandshake.responder(respStatic);

  // Responder cannot write before reading msg1.
  assert.throws(() => responder.writeMessage());
  // Initiator cannot read before writing msg1.
  assert.throws(() => initiator.readMessage(Buffer.alloc(48)));
});
