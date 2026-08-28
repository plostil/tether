/** Uint8Array <-> base64 for the browser (no Buffer here). */

export function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** base64url (no padding) — used in the pairing URL fragment. */
export function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64Url(b64url: string): Uint8Array {
  const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/');
  return fromB64(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}
