/**
 * Generate deterministic Noise_IK cross-language test vectors from the canonical
 * TS reference. The Kotlin and C++ ports embed these exact bytes to prove wire
 * compatibility. Run: `node packages/protocol/tools/gen-vectors.ts`
 */

import {
  NoiseHandshake,
  staticKeypairFromPrivate,
  deviceIdFromPublicKey,
} from '../src/index.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const seed = (byte: number) => new Uint8Array(32).fill(byte);

// Fixed private seeds for reproducibility (any 32 bytes are valid X25519 seeds).
const initStatic = staticKeypairFromPrivate(seed(0x01));
const respStatic = staticKeypairFromPrivate(seed(0x02));
const initEph = staticKeypairFromPrivate(seed(0x03));
const respEph = staticKeypairFromPrivate(seed(0x04));

const initiator = NoiseHandshake.initiator(initStatic, respStatic.publicKey, { ephemeral: initEph });
const responder = NoiseHandshake.responder(respStatic, { ephemeral: respEph });

const msg1 = initiator.writeMessage(Buffer.from('msg1-payload'));
const recv1 = responder.readMessage(msg1);
const msg2 = responder.writeMessage(Buffer.from('msg2-payload'));
const recv2 = initiator.readMessage(msg2);

const it = initiator.split();
const rt = responder.split();

// One transport message each way (nonce 0 on each sender).
const t_i2r = it.send.encryptWithAd(new Uint8Array(0), Buffer.from('phone->pc'));
const t_r2i = rt.send.encryptWithAd(new Uint8Array(0), Buffer.from('pc->phone'));

const vectors = {
  description: 'Noise_IK_25519_ChaChaPoly_BLAKE2s deterministic vectors (SPEC §4)',
  inputs: {
    initStaticPriv: hex(initStatic.privateKey),
    initStaticPub: hex(initStatic.publicKey),
    respStaticPriv: hex(respStatic.privateKey),
    respStaticPub: hex(respStatic.publicKey),
    initEphPriv: hex(initEph.privateKey),
    respEphPriv: hex(respEph.privateKey),
    msg1Payload: 'msg1-payload',
    msg2Payload: 'msg2-payload',
  },
  expect: {
    initiatorDeviceId: deviceIdFromPublicKey(initStatic.publicKey),
    responderDeviceId: deviceIdFromPublicKey(respStatic.publicKey),
    msg1: hex(msg1),
    msg2: hex(msg2),
    recv1Plaintext: Buffer.from(recv1).toString(),
    recv2Plaintext: Buffer.from(recv2).toString(),
    handshakeHash: hex(initiator.handshakeHash),
    transport_initiatorToResponder_plaintext: 'phone->pc',
    transport_initiatorToResponder_ciphertext: hex(t_i2r),
    transport_responderToInitiator_plaintext: 'pc->phone',
    transport_responderToInitiator_ciphertext: hex(t_r2i),
  },
};

// Sanity: both sides agree.
if (hex(initiator.handshakeHash) !== hex(responder.handshakeHash)) {
  throw new Error('handshake hash mismatch — generator is broken');
}

console.log(JSON.stringify(vectors, null, 2));
