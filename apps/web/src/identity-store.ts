/**
 * Persistent device identity: a 32-byte X25519 private seed in localStorage.
 * Per-origin (and per-browser), which matches the "a device IS its key" model —
 * the PC's browser and the phone's browser are two distinct Tether devices.
 */

import { x25519 } from '@noble/curves/ed25519';
import type { StaticKeypair } from '@tether/protocol/browser';
import { fromB64, toB64 } from './b64.ts';

const STORAGE_KEY = 'tether-identity-v1';

export function loadOrCreateIdentity(): StaticKeypair {
  let priv: Uint8Array | null = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const bytes = fromB64(stored);
      if (bytes.length === 32) priv = bytes;
    }
  } catch {
    // storage unavailable (private browsing etc.) — fall through to ephemeral
  }
  if (!priv) {
    priv = x25519.utils.randomPrivateKey();
    try {
      localStorage.setItem(STORAGE_KEY, toB64(priv));
    } catch {
      // ephemeral identity for this page load only
    }
  }
  return { privateKey: priv, publicKey: x25519.getPublicKey(priv) };
}
