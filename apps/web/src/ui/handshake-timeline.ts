import { h } from './dom.ts';
import type { HandshakeStep, StepStatus } from '../secure-link.ts';

const COPY: Record<HandshakeStep, string> = {
  register: 'Prove identity to the broker: the public key hashes (SHA-256, base32) to the device id.',
  watch: 'Ask the broker to signal when the peer is online. No key material moves.',
  msg1: "Noise_IK message 1: our ephemeral key, plus our static key encrypted to the peer's public key.",
  msg2: 'Message 2: the peer ephemeral key. Three X25519 agreements feed a BLAKE2s KDF; both sides share session keys.',
  verified: 'The authenticated key hashes to the expected fingerprint. Split into two ChaCha20-Poly1305 ciphers.',
};
const ORDER: HandshakeStep[] = ['register', 'watch', 'msg1', 'msg2', 'verified'];

export interface HandshakeTimeline {
  el: HTMLElement;
  set(step: HandshakeStep, status: StepStatus): void;
  reset(): void;
}

export function HandshakeTimeline(): HandshakeTimeline {
  const items = {} as Record<HandshakeStep, HTMLElement>;
  const ul = h('ul', { class: 'timeline' });
  for (const s of ORDER) {
    const li = h(
      'li',
      { class: 'timeline__step', 'data-status': 'pending', 'data-testid': `hs-step-${s}` },
      h('span', { class: 'timeline__dot' }),
      h('div', {}, h('span', { class: 'timeline__name' }, s), h('span', { class: 'timeline__desc' }, COPY[s])),
    );
    items[s] = li;
    ul.append(li);
  }
  return {
    el: ul,
    set: (step, status) => items[step].setAttribute('data-status', status),
    reset: () => ORDER.forEach((s) => items[s].setAttribute('data-status', 'pending')),
  };
}
