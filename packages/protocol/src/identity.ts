/**
 * Device identity (SPEC §4).
 *
 * A device's long-term identity IS its public key: the device ID is a
 * fingerprint (base32 of SHA-256) of the raw X25519 public key, the Syncthing
 * model. There is no separate registry to trust or revoke — to trust a device
 * is to know its key. The QR shown during pairing carries this key; the peer
 * verifies that whatever key completes the Noise handshake fingerprints to the
 * scanned ID.
 *
 * These helpers use node:crypto so the server and any Node client share one
 * implementation. Android/Windows clients reproduce the SAME byte-level format
 * with their platform crypto — the wire representation is the contract.
 */

import { createHash, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { base32Encode } from './encoding.ts';

// Pure string/byte encodings live in encoding.ts (shared with the browser
// client, which cannot import this file's node:crypto). Re-exported so the
// @tether/protocol surface is unchanged.
export { base32Encode, displayFingerprint } from './encoding.ts';

/** Raw 32-byte X25519 public key -> compact device ID (base32 of its hash). */
export function deviceIdFromPublicKey(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) {
    throw new Error(`X25519 public key must be 32 bytes, got ${rawPublicKey.length}`);
  }
  const hash = createHash('sha256').update(rawPublicKey).digest();
  return base32Encode(hash);
}

/** Extract the raw 32-byte public key from a node X25519 KeyObject. */
export function rawPublicKeyOf(publicKey: KeyObject): Uint8Array {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('key is not an X25519 public key');
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

export interface DeviceKeypair {
  deviceId: string;
  rawPublicKey: Uint8Array;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

/** Generate a fresh device identity. Clients do this once, on first run. */
export function generateDeviceKeypair(): DeviceKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const rawPublicKey = rawPublicKeyOf(publicKey);
  return {
    deviceId: deviceIdFromPublicKey(rawPublicKey),
    rawPublicKey,
    publicKey,
    privateKey,
  };
}

/** Verify a presented public key matches a claimed device ID (anti-spoof). */
export function publicKeyMatchesId(rawPublicKey: Uint8Array, claimedId: string): boolean {
  try {
    return deviceIdFromPublicKey(rawPublicKey) === claimedId;
  } catch {
    return false;
  }
}
