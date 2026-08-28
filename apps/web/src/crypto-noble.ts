/**
 * @noble-backed primitives for the shared Noise core (noise-core.ts).
 *
 * WebCrypto has neither BLAKE2s nor ChaCha20-Poly1305, so the browser client
 * uses these audited pure-JS implementations. They MUST stay byte-identical to
 * the node:crypto backend — test/noise-noble-vectors.test.ts pins them to
 * docs/noise-test-vectors.json, and test/interop.test.ts handshakes them
 * directly against nodeNoisePrimitives.
 */

import { blake2s } from '@noble/hashes/blake2s';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { x25519 } from '@noble/curves/ed25519';
import { base32Encode, type NoisePrimitives, type StaticKeypair } from '@tether/protocol/browser';

export const nobleNoisePrimitives: NoisePrimitives = {
  blake2s(data) {
    return blake2s(data);
  },
  hmacBlake2s(key, data) {
    return hmac(blake2s, key, data);
  },
  dh(privRaw, pubRaw) {
    return x25519.getSharedSecret(privRaw, pubRaw);
  },
  aeadSeal(key, nonce, ad, plaintext) {
    return chacha20poly1305(key, nonce, ad).encrypt(plaintext);
  },
  aeadOpen(key, nonce, ad, ciphertext) {
    return chacha20poly1305(key, nonce, ad).decrypt(ciphertext); // throws on auth failure
  },
  generateKeypair,
};

export function generateKeypair(): StaticKeypair {
  const privateKey = x25519.utils.randomPrivateKey();
  return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
}

export function staticKeypairFromPrivate(privRaw: Uint8Array): StaticKeypair {
  return { privateKey: new Uint8Array(privRaw), publicKey: x25519.getPublicKey(privRaw) };
}

/** Same format as identity.ts deviceIdFromPublicKey: base32(SHA-256(raw key)). */
export function deviceIdFromPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(`X25519 public key must be 32 bytes, got ${rawPublicKey.length}`);
  }
  return base32Encode(sha256(rawPublicKey));
}
