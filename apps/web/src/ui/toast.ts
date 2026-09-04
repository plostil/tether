import { h } from './dom.ts';
import type { Tone } from './status-pill.ts';

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  if (!host) {
    host = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/** Transient corner toast; auto-dismisses. */
export function toast(tone: Tone, message: string, ms = 4000): void {
  const el = h('div', { class: 'toast', 'data-tone': tone }, message);
  ensureHost().append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, ms);
}

export interface BannerOpts {
  tone?: Tone;
  message: string;
  actions?: HTMLElement[];
  testid?: string;
}

/** Persistent inline banner (for a live fault with an optional retry). */
export function Banner(opts: BannerOpts): HTMLElement {
  const body = h('div', { class: 'banner__body' }, opts.message);
  const kids: (Node | string)[] = [body];
  if (opts.actions?.length) kids.push(h('div', { class: 'row' }, ...opts.actions));
  return h('div', { class: 'banner', 'data-tone': opts.tone ?? 'fault', 'data-testid': opts.testid ?? 'fault' }, ...kids);
}
