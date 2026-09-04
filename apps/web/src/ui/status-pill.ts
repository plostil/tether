import { h } from './dom.ts';

export type Tone = 'neutral' | 'info' | 'secure' | 'warn' | 'fault';

export interface StatusPill {
  el: HTMLElement;
  set(tone: Tone, text: string): void;
}

export function StatusPill(initial = 'idle', testid?: string): StatusPill {
  const dot = h('span', { class: 'pill__dot' });
  const label = document.createTextNode(initial);
  const el = h('span', { class: 'pill', 'data-testid': testid }, dot, label);
  return {
    el,
    set(tone, text) {
      if (tone === 'neutral') el.removeAttribute('data-tone');
      else el.setAttribute('data-tone', tone);
      label.textContent = text;
    },
  };
}
