/**
 * Persistent device identity: a 32-byte X25519 private seed in localStorage.
 * Per-origin (and per-browser), which matches the "a device IS its key" model —
 * the PC's browser and the phone's browser are two distinct Tether devices.
 *
 * The storage key is a parameter so the in-page virtual device (demo mode) can
 * keep a SEPARATE identity in the same browser, giving it a different device id
 * and so avoiding the broker's same-id displacement.
 */

import { x25519 } from '@noble/curves/ed25519';
import type { StaticKeypair } from '@tether/protocol/browser';
import { fromB64, toB64 } from './b64.ts';

export const IDENTITY_KEY = 'tether-identity-v1';
export const DEMO_IDENTITY_KEY = 'tether-demo-identity-v1';

export function loadOrCreateIdentity(storageKey: string = IDENTITY_KEY): StaticKeypair {
  let priv: Uint8Array | null = null;
  try {
    const stored = localStorage.getItem(storageKey);
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
      localStorage.setItem(storageKey, toB64(priv));
    } catch {
      // ephemeral identity for this page load only
    }
  }
  return { privateKey: priv, publicKey: x25519.getPublicKey(priv) };
}

/** Export the raw seed as base64 (Settings → back up identity). */
export function exportIdentitySeed(storageKey: string = IDENTITY_KEY): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

/** Discard the current identity and mint a fresh one. All existing peers must
 *  re-pair, because this device's id (its key fingerprint) changes. */
export function regenerateIdentity(storageKey: string = IDENTITY_KEY): StaticKeypair {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // ignore
  }
  return loadOrCreateIdentity(storageKey);
}
