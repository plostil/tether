/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s (SPEC §4).
 *
 * This is the session-establishment handshake between two paired devices. It
 * runs END-TO-END inside the broker's opaque relay blobs — the server never sees
 * these bytes. IK is the right pattern for our flow: the initiator already knows
 * the responder's static public key (it scanned the QR), so pairing is 1-RTT and
 * mutually authenticated from known static keys, with forward secrecy.
 *
 * This TypeScript file is the CANONICAL REFERENCE. The Android (Kotlin) and
 * Windows (C++) clients must produce byte-identical handshakes. Cross-check
 * against the official Noise test vectors before locking wire compatibility
 * (see noise.test.ts — current tests are self-consistency + regression KAT).
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

const HASHLEN = 32;
const DHLEN = 32;
const TAGLEN = 16;
const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_BLAKE2s';

// DER wrappers to import raw 32-byte X25519 keys (RFC 8410 OIDs).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex'); // public
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex'); // private

export interface StaticKeypair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

export interface TransportPair {
  /** Cipher for messages THIS party sends. */
  send: CipherState;
  /** Cipher for messages THIS party receives. */
  recv: CipherState;
}

// ---- primitives -------------------------------------------------------------

function blake2s(data: Uint8Array): Buffer {
  return createHash('blake2s256').update(data).digest();
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('blake2s256', key).update(data).digest();
}

/** Noise HKDF: derive 2 or 3 keys from a chaining key + input material. */
function hkdf(chainingKey: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Buffer[] {
  const tempKey = hmac(chainingKey, ikm);
  const o1 = hmac(tempKey, Buffer.from([0x01]));
  const o2 = hmac(tempKey, Buffer.concat([o1, Buffer.from([0x02])]));
  if (outputs === 2) return [o1, o2];
  const o3 = hmac(tempKey, Buffer.concat([o2, Buffer.from([0x03])]));
  return [o1, o2, o3];
}

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

function dh(privRaw: Uint8Array, pubRaw: Uint8Array): Buffer {
  return diffieHellman({ privateKey: importPrivate(privRaw), publicKey: importPublic(pubRaw) });
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

// ---- CipherState ------------------------------------------------------------

export class CipherState {
  private k: Buffer | null = null;
  private n = 0n;

  initializeKey(k: Buffer | null): void {
    this.k = k;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  private nonceBytes(): Buffer {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(this.n, 4); // 4 zero bytes || 64-bit LE counter
    return nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (!this.k) return Buffer.from(plaintext);
    // Node's types file chacha20-poly1305 under CCM (setAAD needs 2 args), but
    // at runtime it behaves like GCM; cast so the single-arg setAAD typechecks.
    const cipher = createCipheriv('chacha20-poly1305', this.k, this.nonceBytes(), {
      authTagLength: TAGLEN,
    }) as unknown as CipherGCM;
    cipher.setAAD(Buffer.from(ad));
    const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
    const out = Buffer.concat([ct, cipher.getAuthTag()]);
    this.n++;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (!this.k) return Buffer.from(ciphertext);
    const buf = Buffer.from(ciphertext);
    const ct = buf.subarray(0, buf.length - TAGLEN);
    const tag = buf.subarray(buf.length - TAGLEN);
    const decipher = createDecipheriv('chacha20-poly1305', this.k, this.nonceBytes(), {
      authTagLength: TAGLEN,
    }) as unknown as DecipherGCM;
    decipher.setAAD(Buffer.from(ad));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on auth failure
    this.n++;
    return pt;
  }
}

// ---- SymmetricState ---------------------------------------------------------

class SymmetricState {
  private ck: Buffer;
  private h: Buffer;
  readonly cipher = new CipherState();

  constructor() {
    const name = Buffer.from(PROTOCOL_NAME, 'utf8');
    this.h = name.length <= HASHLEN ? Buffer.concat([name, Buffer.alloc(HASHLEN - name.length)]) : blake2s(name);
    this.ck = Buffer.from(this.h);
  }

  get handshakeHash(): Buffer {
    return this.h;
  }

  mixHash(data: Uint8Array): void {
    this.h = blake2s(Buffer.concat([this.h, Buffer.from(data)]));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, ikm, 2);
    this.ck = ck!;
    this.cipher.initializeKey(tempK!);
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, new Uint8Array(0), 2);
    const c1 = new CipherState();
    const c2 = new CipherState();
    c1.initializeKey(k1!);
    c2.initializeKey(k2!);
    return [c1, c2];
  }
}

// ---- HandshakeState (IK) ----------------------------------------------------

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss';
const IK_MESSAGES: Token[][] = [
  ['e', 'es', 's', 'ss'], // initiator -> responder
  ['e', 'ee', 'se'], // responder -> initiator
];

export interface HandshakeOptions {
  /** Inject a fixed ephemeral keypair for deterministic test vectors. */
  ephemeral?: StaticKeypair;
  /** Optional prologue mixed into both transcripts (must match on both ends). */
  prologue?: Uint8Array;
}

export class NoiseHandshake {
  private readonly ss = new SymmetricState();
  private readonly initiator: boolean;
  private readonly s: StaticKeypair;
  private rs: Uint8Array | null; // remote static
  private e: StaticKeypair | null = null;
  private re: Uint8Array | null = null; // remote ephemeral
  private step = 0;
  private readonly ephemeralOverride?: StaticKeypair;

  private constructor(initiator: boolean, s: StaticKeypair, rs: Uint8Array | null, opts: HandshakeOptions) {
    this.initiator = initiator;
    this.s = s;
    this.rs = rs;
    this.ephemeralOverride = opts.ephemeral;

    this.ss.mixHash(opts.prologue ?? new Uint8Array(0));
    // Pre-message: the responder's static public key is known to both.
    // (IK pre-message pattern: "<- s".)
    const responderStatic = initiator ? rs! : s.publicKey;
    this.ss.mixHash(responderStatic);
  }

  /** Initiator must already know the responder's static public key (from the QR). */
  static initiator(s: StaticKeypair, responderStatic: Uint8Array, opts: HandshakeOptions = {}): NoiseHandshake {
    return new NoiseHandshake(true, s, responderStatic, opts);
  }

  static responder(s: StaticKeypair, opts: HandshakeOptions = {}): NoiseHandshake {
    return new NoiseHandshake(false, s, null, opts);
  }

  get isComplete(): boolean {
    return this.step >= IK_MESSAGES.length;
  }

  /** The authenticated remote static key, available after it has been received. */
  get remoteStaticKey(): Uint8Array | null {
    return this.rs;
  }

  /** True when it is this party's turn to writeMessage(). */
  get isMyTurn(): boolean {
    if (this.isComplete) return false;
    const writerIsInitiator = this.step % 2 === 0;
    return writerIsInitiator === this.initiator;
  }

  private newEphemeral(): StaticKeypair {
    return this.ephemeralOverride ?? generateStaticKeypair();
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.isMyTurn) throw new Error('noise: not this party\'s turn to write');
    const tokens = IK_MESSAGES[this.step]!;
    const parts: Buffer[] = [];

    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.e = this.newEphemeral();
          this.ss.mixHash(this.e.publicKey);
          parts.push(Buffer.from(this.e.publicKey));
          break;
        }
        case 's': {
          parts.push(this.ss.encryptAndHash(this.s.publicKey));
          break;
        }
        case 'ee':
          this.ss.mixKey(dh(this.e!.privateKey, this.re!));
          break;
        case 'es':
          this.ss.mixKey(this.initiator ? dh(this.e!.privateKey, this.rs!) : dh(this.s.privateKey, this.re!));
          break;
        case 'se':
          this.ss.mixKey(this.initiator ? dh(this.s.privateKey, this.re!) : dh(this.e!.privateKey, this.rs!));
          break;
        case 'ss':
          this.ss.mixKey(dh(this.s.privateKey, this.rs!));
          break;
      }
    }
    parts.push(this.ss.encryptAndHash(payload));
    this.step++;
    return Buffer.concat(parts);
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.isMyTurn) throw new Error('noise: not this party\'s turn to read');
    const tokens = IK_MESSAGES[this.step]!;
    let buf = Buffer.from(message);

    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.re = new Uint8Array(buf.subarray(0, DHLEN));
          this.ss.mixHash(this.re);
          buf = buf.subarray(DHLEN);
          break;
        }
        case 's': {
          const hasKey = this.ss.cipher.hasKey();
          const len = hasKey ? DHLEN + TAGLEN : DHLEN;
          this.rs = new Uint8Array(this.ss.decryptAndHash(buf.subarray(0, len)));
          buf = buf.subarray(len);
          break;
        }
        case 'ee':
          this.ss.mixKey(dh(this.e!.privateKey, this.re!));
          break;
        case 'es':
          this.ss.mixKey(this.initiator ? dh(this.e!.privateKey, this.rs!) : dh(this.s.privateKey, this.re!));
          break;
        case 'se':
          this.ss.mixKey(this.initiator ? dh(this.s.privateKey, this.re!) : dh(this.e!.privateKey, this.rs!));
          break;
        case 'ss':
          this.ss.mixKey(dh(this.s.privateKey, this.rs!));
          break;
      }
    }
    const payload = this.ss.decryptAndHash(buf);
    this.step++;
    return payload;
  }

  /**
   * After the handshake completes, derive the two transport ciphers. The
   * mapping is role-dependent so each side's `send` matches the peer's `recv`.
   */
  split(): TransportPair {
    if (!this.isComplete) throw new Error('noise: handshake not complete');
    const [c1, c2] = this.ss.split();
    // Per Noise: first cipher is initiator->responder, second responder->initiator.
    return this.initiator ? { send: c1, recv: c2 } : { send: c2, recv: c1 };
  }

  /** Transcript hash — useful as a channel binding / short auth string source. */
  get handshakeHash(): Uint8Array {
    return this.ss.handshakeHash;
  }
}
