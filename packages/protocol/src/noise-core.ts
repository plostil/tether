/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2s — portable core (SPEC §4).
 *
 * The handshake state machine, HKDF, and cipher/nonce layout live here with NO
 * platform dependencies (no node:crypto, no Buffer) so the same canonical logic
 * runs in Node AND in a browser. The actual primitives (BLAKE2s, X25519,
 * ChaCha20-Poly1305) are injected via `NoisePrimitives`:
 *
 *   - Node backend: `nodeNoisePrimitives` in noise.ts (node:crypto).
 *   - Browser backend: apps/web binds @noble/* (WebCrypto lacks BLAKE2s and
 *     ChaCha20-Poly1305, so pure-JS primitives are the only option there).
 *
 * Both backends must pass docs/noise-test-vectors.json byte-for-byte. noise.ts
 * remains the canonical Node-facing entry; this file is the shared engine it
 * (and the web client) delegate to.
 */

export const HASHLEN = 32;
export const DHLEN = 32;
export const TAGLEN = 16;
export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_BLAKE2s';

export interface StaticKeypair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes
}

/** The primitive set a platform must supply to run the handshake. */
export interface NoisePrimitives {
  blake2s(data: Uint8Array): Uint8Array; // 32-byte digest
  hmacBlake2s(key: Uint8Array, data: Uint8Array): Uint8Array;
  dh(privRaw: Uint8Array, pubRaw: Uint8Array): Uint8Array; // X25519, 32 bytes
  /** ChaCha20-Poly1305 seal: returns ciphertext || 16-byte tag. */
  aeadSeal(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** ChaCha20-Poly1305 open: throws on auth failure. */
  aeadOpen(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  generateKeypair(): StaticKeypair;
}

export interface CoreTransportPair {
  /** Cipher for messages THIS party sends. */
  send: CoreCipherState;
  /** Cipher for messages THIS party receives. */
  recv: CoreCipherState;
}

export interface HandshakeOptions {
  /** Inject a fixed ephemeral keypair for deterministic test vectors. */
  ephemeral?: StaticKeypair;
  /** Optional prologue mixed into both transcripts (must match on both ends). */
  prologue?: Uint8Array;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Noise HKDF: derive 2 or 3 keys from a chaining key + input material. */
function hkdf(
  prim: NoisePrimitives,
  chainingKey: Uint8Array,
  ikm: Uint8Array,
  outputs: 2 | 3,
): Uint8Array[] {
  const tempKey = prim.hmacBlake2s(chainingKey, ikm);
  const o1 = prim.hmacBlake2s(tempKey, Uint8Array.of(0x01));
  const o2 = prim.hmacBlake2s(tempKey, concat(o1, Uint8Array.of(0x02)));
  if (outputs === 2) return [o1, o2];
  const o3 = prim.hmacBlake2s(tempKey, concat(o2, Uint8Array.of(0x03)));
  return [o1, o2, o3];
}

// ---- CipherState ------------------------------------------------------------

export class CoreCipherState {
  private k: Uint8Array | null = null;
  private n = 0n;
  private readonly prim: NoisePrimitives;

  constructor(prim: NoisePrimitives) {
    this.prim = prim;
  }

  initializeKey(k: Uint8Array | null): void {
    this.k = k;
    this.n = 0n;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  private nonceBytes(): Uint8Array {
    const nonce = new Uint8Array(12);
    new DataView(nonce.buffer).setBigUint64(4, this.n, true); // 4 zero bytes || 64-bit LE counter
    return nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return new Uint8Array(plaintext);
    const out = this.prim.aeadSeal(this.k, this.nonceBytes(), ad, plaintext);
    this.n++;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return new Uint8Array(ciphertext);
    const pt = this.prim.aeadOpen(this.k, this.nonceBytes(), ad, ciphertext); // throws on auth failure
    this.n++;
    return pt;
  }
}

// ---- SymmetricState ---------------------------------------------------------

class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  readonly cipher: CoreCipherState;
  private readonly prim: NoisePrimitives;

  constructor(prim: NoisePrimitives) {
    this.prim = prim;
    this.cipher = new CoreCipherState(prim);
    const name = new TextEncoder().encode(PROTOCOL_NAME);
    this.h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : prim.blake2s(name);
    this.ck = new Uint8Array(this.h);
  }

  get handshakeHash(): Uint8Array {
    return this.h;
  }

  mixHash(data: Uint8Array): void {
    this.h = this.prim.blake2s(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf(this.prim, this.ck, ikm, 2);
    this.ck = ck!;
    this.cipher.initializeKey(tempK!);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CoreCipherState, CoreCipherState] {
    const [k1, k2] = hkdf(this.prim, this.ck, new Uint8Array(0), 2);
    const c1 = new CoreCipherState(this.prim);
    const c2 = new CoreCipherState(this.prim);
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

export class CoreNoiseHandshake {
  private readonly ss: SymmetricState;
  private readonly initiator: boolean;
  private readonly s: StaticKeypair;
  private rs: Uint8Array | null; // remote static
  private e: StaticKeypair | null = null;
  private re: Uint8Array | null = null; // remote ephemeral
  private step = 0;
  private readonly ephemeralOverride?: StaticKeypair;

  private readonly prim: NoisePrimitives;

  private constructor(
    prim: NoisePrimitives,
    initiator: boolean,
    s: StaticKeypair,
    rs: Uint8Array | null,
    opts: HandshakeOptions,
  ) {
    this.prim = prim;
    this.ss = new SymmetricState(prim);
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
  static initiator(
    prim: NoisePrimitives,
    s: StaticKeypair,
    responderStatic: Uint8Array,
    opts: HandshakeOptions = {},
  ): CoreNoiseHandshake {
    return new CoreNoiseHandshake(prim, true, s, responderStatic, opts);
  }

  static responder(prim: NoisePrimitives, s: StaticKeypair, opts: HandshakeOptions = {}): CoreNoiseHandshake {
    return new CoreNoiseHandshake(prim, false, s, null, opts);
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
    return this.ephemeralOverride ?? this.prim.generateKeypair();
  }

  writeMessage(payload: Uint8Array = new Uint8Array(0)): Uint8Array {
    if (!this.isMyTurn) throw new Error('noise: not this party\'s turn to write');
    const tokens = IK_MESSAGES[this.step]!;
    const parts: Uint8Array[] = [];

    for (const token of tokens) {
      switch (token) {
        case 'e': {
          this.e = this.newEphemeral();
          this.ss.mixHash(this.e.publicKey);
          parts.push(this.e.publicKey);
          break;
        }
        case 's': {
          parts.push(this.ss.encryptAndHash(this.s.publicKey));
          break;
        }
        case 'ee':
          this.ss.mixKey(this.prim.dh(this.e!.privateKey, this.re!));
          break;
        case 'es':
          this.ss.mixKey(
            this.initiator ? this.prim.dh(this.e!.privateKey, this.rs!) : this.prim.dh(this.s.privateKey, this.re!),
          );
          break;
        case 'se':
          this.ss.mixKey(
            this.initiator ? this.prim.dh(this.s.privateKey, this.re!) : this.prim.dh(this.e!.privateKey, this.rs!),
          );
          break;
        case 'ss':
          this.ss.mixKey(this.prim.dh(this.s.privateKey, this.rs!));
          break;
      }
    }
    parts.push(this.ss.encryptAndHash(payload));
    this.step++;
    return concat(...parts);
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.isMyTurn) throw new Error('noise: not this party\'s turn to read');
    const tokens = IK_MESSAGES[this.step]!;
    let buf = message;

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
          this.ss.mixKey(this.prim.dh(this.e!.privateKey, this.re!));
          break;
        case 'es':
          this.ss.mixKey(
            this.initiator ? this.prim.dh(this.e!.privateKey, this.rs!) : this.prim.dh(this.s.privateKey, this.re!),
          );
          break;
        case 'se':
          this.ss.mixKey(
            this.initiator ? this.prim.dh(this.s.privateKey, this.re!) : this.prim.dh(this.e!.privateKey, this.rs!),
          );
          break;
        case 'ss':
          this.ss.mixKey(this.prim.dh(this.s.privateKey, this.rs!));
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
  split(): CoreTransportPair {
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
