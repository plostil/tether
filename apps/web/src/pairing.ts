/**
 * The pairing blob: the responder's device id + raw X25519 public key, exactly
 * what the QR carries in the URL fragment (never sent to the server). The
 * initiator uses it to run Noise_IK; the fingerprint is still verified against
 * the authenticated key after the handshake (anti-MITM).
 */

import { fromB64Url, toB64Url } from './b64.ts';

export interface PairBlob {
  id: string;
  key: string; // base64 (standard) raw X25519 public key
}

/** Build the full pairing URL a phone opens after scanning the QR. */
export function encodePairUrl(blob: PairBlob, host: string, port: string): string {
  const frag = toB64Url(new TextEncoder().encode(JSON.stringify(blob)));
  const portPart = port && port !== '80' ? `:${port}` : '';
  return `http://${host}${portPart}/#/pair/join?blob=${frag}`;
}

/** Parse a pairing blob out of a location hash, tolerating both the legacy
 *  `#pair=<blob>` form and the new `#/pair/join?blob=<blob>` form. */
export function parsePairFragment(hash: string): PairBlob | null {
  const legacy = hash.match(/[#&]pair=([A-Za-z0-9_-]+)/);
  const routed = hash.match(/[?&]blob=([A-Za-z0-9_-]+)/);
  const raw = routed?.[1] ?? legacy?.[1];
  if (!raw) return null;
  try {
    const blob = JSON.parse(new TextDecoder().decode(fromB64Url(raw))) as PairBlob;
    if (typeof blob.id === 'string' && typeof blob.key === 'string') return blob;
    return null;
  } catch {
    return null;
  }
}
