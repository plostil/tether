/**
 * The @noble browser backend must reproduce docs/noise-test-vectors.json
 * byte-for-byte — the same vectors the Node, Kotlin, and C++ backends pin.
 * If this fails, the web client would pair with nobody.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreNoiseHandshake } from '@tether/protocol/browser';
import { deviceIdFromPublicKey, nobleNoisePrimitives, staticKeypairFromPrivate } from '../src/crypto-noble.ts';

const vectorsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'noise-test-vectors.json');
const vectors = JSON.parse(readFileSync(vectorsPath, 'utf8')) as {
  inputs: Record<string, string>;
  expect: Record<string, string>;
};

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

test('noble backend reproduces the shared cross-language vectors', () => {
  const { inputs: I, expect: E } = vectors;

  const initStatic = staticKeypairFromPrivate(fromHex(I.initStaticPriv!));
  const respStatic = staticKeypairFromPrivate(fromHex(I.respStaticPriv!));
  assert.equal(hex(initStatic.publicKey), I.initStaticPub);
  assert.equal(hex(respStatic.publicKey), I.respStaticPub);

  // Device ids: validates the web client's sha256+base32 fingerprint path too.
  assert.equal(deviceIdFromPublicKey(initStatic.publicKey), E.initiatorDeviceId);
  assert.equal(deviceIdFromPublicKey(respStatic.publicKey), E.responderDeviceId);

  const initiator = CoreNoiseHandshake.initiator(nobleNoisePrimitives, initStatic, respStatic.publicKey, {
    ephemeral: staticKeypairFromPrivate(fromHex(I.initEphPriv!)),
  });
  const responder = CoreNoiseHandshake.responder(nobleNoisePrimitives, respStatic, {
    ephemeral: staticKeypairFromPrivate(fromHex(I.respEphPriv!)),
  });

  const msg1 = initiator.writeMessage(utf8(I.msg1Payload!));
  assert.equal(hex(msg1), E.msg1);
  assert.equal(new TextDecoder().decode(responder.readMessage(msg1)), E.recv1Plaintext);

  const msg2 = responder.writeMessage(utf8(I.msg2Payload!));
  assert.equal(hex(msg2), E.msg2);
  assert.equal(new TextDecoder().decode(initiator.readMessage(msg2)), E.recv2Plaintext);

  assert.equal(hex(initiator.handshakeHash), E.handshakeHash);
  assert.equal(hex(responder.handshakeHash), E.handshakeHash);

  const iT = initiator.split();
  const rT = responder.split();
  const ad = new Uint8Array(0);

  const ct1 = iT.send.encryptWithAd(ad, utf8(E.transport_initiatorToResponder_plaintext!));
  assert.equal(hex(ct1), E.transport_initiatorToResponder_ciphertext);
  assert.equal(
    new TextDecoder().decode(rT.recv.decryptWithAd(ad, ct1)),
    E.transport_initiatorToResponder_plaintext,
  );

  const ct2 = rT.send.encryptWithAd(ad, utf8(E.transport_responderToInitiator_plaintext!));
  assert.equal(hex(ct2), E.transport_responderToInitiator_ciphertext);
  assert.equal(
    new TextDecoder().decode(iT.recv.decryptWithAd(ad, ct2)),
    E.transport_responderToInitiator_plaintext,
  );
});
