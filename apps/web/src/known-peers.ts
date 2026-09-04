/**
 * Remembered peers, so you pair once and reconnect without re-scanning the QR.
 * We store each peer's device id + public key (its public identity — the same
 * thing the QR carried). On reconnect this page becomes the initiator again
 * using this saved key, and still verifies the fingerprint (anti-MITM).
 */

import { fromB64, toB64 } from './b64.ts';

const STORAGE_KEY = 'tether-known-peers-v1';

export type VerifiedBy = 'qr' | 'code' | 'link' | 'demo';

export interface KnownPeer {
  id: string;
  key: string; // base64 raw X25519 public key
  label: string;
  lastSeen: number;
  /** How the key was trusted the first time (TOFU provenance). */
  verifiedBy?: VerifiedBy;
  /** True for the in-page demo peer — "Connect" re-spawns a virtual device. */
  demo?: boolean;
}

export function listKnownPeers(): KnownPeer[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const peers = JSON.parse(raw) as KnownPeer[];
    return peers.sort((a, b) => b.lastSeen - a.lastSeen);
  } catch {
    return [];
  }
}

function write(peers: KnownPeer[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(peers.slice(0, 12)));
  } catch {
    // storage unavailable — reconnect memory just won't persist this session
  }
}

export function rememberPeer(
  id: string,
  publicKey: Uint8Array,
  label: string,
  opts: { verifiedBy?: VerifiedBy; demo?: boolean } = {},
): void {
  const existing = listKnownPeers().find((p) => p.id === id);
  const peers = listKnownPeers().filter((p) => p.id !== id);
  peers.unshift({
    id,
    key: toB64(publicKey),
    label,
    lastSeen: Date.now(),
    verifiedBy: opts.verifiedBy ?? existing?.verifiedBy,
    demo: opts.demo ?? existing?.demo,
  });
  write(peers);
}

export function renamePeer(id: string, label: string): void {
  const peers = listKnownPeers();
  const p = peers.find((x) => x.id === id);
  if (p) {
    p.label = label;
    write(peers);
  }
}

export function forgetPeer(id: string): void {
  write(listKnownPeers().filter((p) => p.id !== id));
}

export function clearKnownPeers(): void {
  write([]);
}

export function peerKeyBytes(peer: KnownPeer): Uint8Array {
  return fromB64(peer.key);
}
