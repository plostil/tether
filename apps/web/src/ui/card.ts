import { h } from './dom.ts';

export interface CardOpts {
  title?: string;
  children: (Node | string)[];
  footer?: (Node | string)[];
}

export function Card(opts: CardOpts): HTMLElement {
  const kids: (Node | string)[] = [];
  if (opts.title) kids.push(h('h2', { class: 'card__title eyebrow' }, opts.title));
  kids.push(...opts.children);
  if (opts.footer) kids.push(h('div', { class: 'card__foot row' }, ...opts.footer));
  return h('div', { class: 'card' }, ...kids);
}
