/**
 * Live interop: a noble-backed party (the browser) handshakes against a
 * node:crypto-backed party (the reference/Node side), with fresh random keys,
 * in both role assignments. This is exactly what happens when the phone's
 * Safari pairs with a Node-adjacent peer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreNoiseHandshake } from '@tether/protocol/browser';
import { nodeNoisePrimitives, generateStaticKeypair } from '@tether/protocol';
import { nobleNoisePrimitives, generateKeypair, deviceIdFromPublicKey } from '../src/crypto-noble.ts';
import { deviceIdFromPublicKey as nodeDeviceId } from '@tether/protocol';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

test('noble initiator <-> node responder', () => {
  const phone = generateKeypair(); // noble
  const pc = generateStaticKeypair(); // node

  const initiator = CoreNoiseHandshake.initiator(nobleNoisePrimitives, phone, pc.publicKey);
  const responder = CoreNoiseHandshake.responder(nodeNoisePrimitives, pc);

  responder.readMessage(initiator.writeMessage(utf8('hi from safari')));
  initiator.readMessage(responder.writeMessage(utf8('hi from node')));
  assert.ok(initiator.isComplete && responder.isComplete);

  // Both ends authenticate the same identities.
  assert.equal(deviceIdFromPublicKey(responder.remoteStaticKey!), deviceIdFromPublicKey(phone.publicKey));
  assert.equal(nodeDeviceId(initiator.remoteStaticKey!), nodeDeviceId(pc.publicKey));

  const iT = initiator.split();
  const rT = responder.split();
  const ad = new Uint8Array(0);
  assert.equal(text(rT.recv.decryptWithAd(ad, iT.send.encryptWithAd(ad, utf8('phone->pc')))), 'phone->pc');
  assert.equal(text(iT.recv.decryptWithAd(ad, rT.send.encryptWithAd(ad, utf8('pc->phone')))), 'pc->phone');
});

test('node initiator <-> noble responder', () => {
  const a = generateStaticKeypair(); // node
  const b = generateKeypair(); // noble

  const initiator = CoreNoiseHandshake.initiator(nodeNoisePrimitives, a, b.publicKey);
  const responder = CoreNoiseHandshake.responder(nobleNoisePrimitives, b);

  responder.readMessage(initiator.writeMessage());
  initiator.readMessage(responder.writeMessage());
  assert.ok(initiator.isComplete && responder.isComplete);

  const iT = initiator.split();
  const rT = responder.split();
  const ad = new Uint8Array(0);
  // Several transport messages each way: nonce sequences must stay in step.
  for (let i = 0; i < 5; i++) {
    assert.equal(text(rT.recv.decryptWithAd(ad, iT.send.encryptWithAd(ad, utf8(`ping ${i}`)))), `ping ${i}`);
    assert.equal(text(iT.recv.decryptWithAd(ad, rT.send.encryptWithAd(ad, utf8(`pong ${i}`)))), `pong ${i}`);
  }
});
