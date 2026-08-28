/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s — Node entry (SPEC §4).
 *
 * This is the session-establishment handshake between two paired devices. It
 * runs END-TO-END inside the broker's opaque relay blobs — the server never sees
 * these bytes. IK is the right pattern for our flow: the initiator already knows
 * the responder's static public key (it scanned the QR), so pairing is 1-RTT and
 * mutually authenticated from known static keys, with forward secrecy.
 *
 * The handshake logic itself lives in noise-core.ts (platform-free, shared with
 * the browser client); this file binds it to node:crypto and keeps the original
 * Buffer-returning public API. Together they are the CANONICAL REFERENCE: the
 * Android (Kotlin) and Windows (C++) clients must produce byte-identical
 * handshakes. Cross-check against docs/noise-test-vectors.json.
 *
 * Spec references: Noise Protocol Framework rev 34.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';
import {
  CoreCipherState,
  CoreNoiseHandshake,
  TAGLEN,
  type HandshakeOptions,
  type NoisePrimitives,
  type StaticKeypair,
} from './noise-core.ts';

export {
  PROTOCOL_NAME,
  CoreCipherState,
  CoreNoiseHandshake,
  type CoreTransportPair,
  type HandshakeOptions,
  type NoisePrimitives,
  type StaticKeypair,
} from './noise-core.ts';

export interface TransportPair {
  /** Cipher for messages THIS party sends. */
  send: CipherState;
  /** Cipher for messages THIS party receives. */
  recv: CipherState;
}

// ---- node:crypto primitives -------------------------------------------------

// DER wrappers to import raw 32-byte X25519 keys (RFC 8410 OIDs).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // public
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // private

function importPublic(raw: Uint8Array): KeyObject {
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

function importPrivate(raw: Uint8Array): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function generateStaticKeypair(): StaticKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return {
    publicKey: new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')),
    privateKey: new Uint8Array(
      Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'),
    ),
  };
}

/**
 * Derive the full keypair from a raw 32-byte private seed. Used to build
 * deterministic cross-language test vectors (see docs/noise-test-vectors.json).
 */
export function staticKeypairFromPrivate(privRaw: Uint8Array): StaticKeypair {
  const privateKey = importPrivate(privRaw);
  const publicKey = createPublicKey(privateKey);
  return {
    privateKey: new Uint8Array(privRaw),
    publicKey: new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url')),
  };
}

/** The node:crypto backend for the shared Noise core. */
export const nodeNoisePrimitives: NoisePrimitives = {
  blake2s(data) {
    return createHash('blake2s256').update(data).digest();
  },
  hmacBlake2s(key, data) {
    return createHmac('blake2s256', key).update(data).digest();
  },
  dh(privRaw, pubRaw) {
    return diffieHellman({ privateKey: importPrivate(privRaw), publicKey: importPublic(pubRaw) });
  },
  aeadSeal(key, nonce, ad, plaintext) {
    // Node's types file chacha20-poly1305 under CCM (setAAD needs 2 args), but
    // at runtime it behaves like GCM; cast so the single-arg setAAD typechecks.
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: TAGLEN,
    }) as unknown as CipherGCM;
    cipher.setAAD(Buffer.from(ad));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    return Buffer.concat([ct, cipher.getAuthTag()]);
  },
  aeadOpen(key, nonce, ad, ciphertext) {
    const buf = Buffer.from(ciphertext);
    const ct = buf.subarray(0, buf.length - TAGLEN);
    const tag = buf.subarray(buf.length - TAGLEN);
    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, {
      authTagLength: TAGLEN,
    }) as unknown as DecipherGCM;
    decipher.setAAD(Buffer.from(ad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on auth failure
  },
  generateKeypair: generateStaticKeypair,
};

// ---- Buffer-returning wrappers (the original Node API) ----------------------

export class CipherState {
  private readonly core: CoreCipherState;

  constructor(core?: CoreCipherState) {
    this.core = core ?? new CoreCipherState(nodeNoisePrimitives);
  }

  initializeKey(k: Buffer | null): void {
    this.core.initializeKey(k);
  }

  hasKey(): boolean {
    return this.core.hasKey();
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    return Buffer.from(this.core.encryptWithAd(ad, plaintext));
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    return Buffer.from(this.core.decryptWithAd(ad, ciphertext));
  }
}

export class NoiseHandshake {
  private readonly core: CoreNoiseHandshake;

  private constructor(core: CoreNoiseHandshake) {
    this.core = core;
  }

  /** Initiator must already know the responder's static public key (from the QR). */
  static initiator(s: StaticKeypair, responderStatic: Uint8Array, opts: HandshakeOptions = {}): NoiseHandshake {
    return new NoiseHandshake(CoreNoiseHandshake.initiator(nodeNoisePrimitives, s, responderStatic, opts));
  }

  static responder(s: StaticKeypair, opts: HandshakeOptions = {}): NoiseHandshake {
    return new NoiseHandshake(CoreNoiseHandshake.responder(nodeNoisePrimitives, s, opts));
  }

  get isComplete(): boolean {
    return this.core.isComplete;
  }

  /** The authenticated remote static key, available after it has been received. */
  get remoteStaticKey(): Uint8Array | null {
    return this.core.remoteStaticKey;
  }

  /** True when it is this party's turn to writeMessage(). */
  get isMyTurn(): boolean {
    return this.core.isMyTurn;
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    return Buffer.from(this.core.writeMessage(payload));
  }

  readMessage(message: Uint8Array): Uint8Array {
    return Buffer.from(this.core.readMessage(message));
  }

  /**
   * After the handshake completes, derive the two transport ciphers. The
   * mapping is role-dependent so each side's `send` matches the peer's `recv`.
   */
  split(): TransportPair {
    const pair = this.core.split();
    return { send: new CipherState(pair.send), recv: new CipherState(pair.recv) };
  }

  /** Transcript hash — useful as a channel binding / short auth string source. */
  get handshakeHash(): Uint8Array {
    return this.core.handshakeHash;
  }
}
