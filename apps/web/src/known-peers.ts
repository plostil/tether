/**
 * Remembered peers, so you pair once and reconnect without re-scanning the QR.
 * We store each peer's device id + public key (its public identity — the same
 * thing the QR carried). On reconnect the phone becomes the initiator again
 * using this saved key, and still verifies the fingerprint (anti-MITM).
 */

import { fromB64, toB64 } from './b64.ts';

const STORAGE_KEY = 'tether-known-peers-v1';

export interface KnownPeer {
  id: string;
  key: string; // base64 raw X25519 public key
  label: string;
  lastSeen: number;
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

export function rememberPeer(id: string, publicKey: Uint8Array, label: string): void {
  try {
    const peers = listKnownPeers().filter((p) => p.id !== id);
    peers.unshift({ id, key: toB64(publicKey), label, lastSeen: Date.now() });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(peers.slice(0, 8)));
  } catch {
    // storage unavailable — reconnect memory just won't persist this session
  }
}

export function forgetPeer(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(listKnownPeers().filter((p) => p.id !== id)));
  } catch {
    // ignore
  }
}

export function peerKeyBytes(peer: KnownPeer): Uint8Array {
  return fromB64(peer.key);
}
