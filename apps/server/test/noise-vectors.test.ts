import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NoiseHandshake,
  staticKeypairFromPrivate,
  deviceIdFromPublicKey,
} from '@tether/protocol';

/**
 * Pins the deterministic cross-language vectors in docs/noise-test-vectors.json.
 * The Kotlin/C++ ports embed these SAME bytes; if this test and the native test
 * both pass, the implementations are wire-compatible. Regenerate with
 * `node packages/protocol/tools/gen-vectors.ts` (and update both sides) only on
 * an intentional protocol change.
 */

const seed = (b: number) => new Uint8Array(32).fill(b);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

const V = {
  initStaticPub: 'a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209',
  respStaticPub: 'ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59',
  initiatorDeviceId: 'DKJPEOCS3SII3FZRNI5RGV4CQEMWYHOXHWNOLYYT6P5WXCKUX5KQ',
  responderDeviceId: 'Z6SXBRSTXUQSWEFJZNKR7V5BWR4JQVPOC7UZ54VTUIBX72ZTPIEA',
  msg1:
    '5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef224391bcfef3f1b0f051873c2103356110f8056ef928c4354783347c74dc7b71b7fd9a860bc9013ff1aaeb4e5e0361f7a982719d50bb4b12f618593b7eb4429d1a545cbeb06b536abad62cd861',
  msg2:
    'ac01b2209e86354fb853237b5de0f4fab13c7fcbf433a61c019369617fecf10bc49ef9949dee69058aed84e1c0ea497064d4c3ada285e59ea5919498',
  handshakeHash: '5115e4f1d7fb9eb9d6d41545a86146da961d88c02bb7a9148e327e91510971b1',
  t_i2r: '66970412dcb4eb2a3a88c6c4ebd6e46746fdcc36b236618370',
  t_r2i: '0ade26655b9fc47bca23570149f7901e492f7795c17e02136d',
};

test('reference implementation matches the pinned cross-language vectors', () => {
  const initStatic = staticKeypairFromPrivate(seed(0x01));
  const respStatic = staticKeypairFromPrivate(seed(0x02));
  const initEph = staticKeypairFromPrivate(seed(0x03));
  const respEph = staticKeypairFromPrivate(seed(0x04));

  assert.equal(hex(initStatic.publicKey), V.initStaticPub);
  assert.equal(hex(respStatic.publicKey), V.respStaticPub);
  assert.equal(deviceIdFromPublicKey(initStatic.publicKey), V.initiatorDeviceId);
  assert.equal(deviceIdFromPublicKey(respStatic.publicKey), V.responderDeviceId);

  const initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey, { ephemeral: initEph });
  const responder = NoiseHandshake.responder(respStatic, { ephemeral: respEph });

  const msg1 = initiator.writeMessage(Buffer.from('msg1-payload'));
  assert.equal(hex(msg1), V.msg1);
  assert.equal(Buffer.from(responder.readMessage(msg1)).toString(), 'msg1-payload');

  const msg2 = responder.writeMessage(Buffer.from('msg2-payload'));
  assert.equal(hex(msg2), V.msg2);
  assert.equal(Buffer.from(initiator.readMessage(msg2)).toString(), 'msg2-payload');

  assert.equal(hex(initiator.handshakeHash), V.handshakeHash);

  const it = initiator.split();
  const rt = responder.split();
  assert.equal(hex(it.send.encryptWithAd(new Uint8Array(0), Buffer.from('phone->pc'))), V.t_i2r);
  assert.equal(hex(rt.send.encryptWithAd(new Uint8Array(0), Buffer.from('pc->phone'))), V.t_r2i);
});
