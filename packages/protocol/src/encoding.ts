/**
 * Pure encoding helpers shared by every client, including the browser one
 * (no node:crypto here — identity.ts layers the hashing on top).
 */

/** RFC 4648 base32 alphabet, no padding — used for device IDs. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Human-checkable fingerprint: the device ID grouped into 7-char blocks. */
export function displayFingerprint(deviceId: string): string {
  return (deviceId.match(/.{1,7}/g) ?? []).join('-');
}
