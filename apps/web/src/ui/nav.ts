import { h } from './dom.ts';

export interface NavRoute {
  href: string;
  label: string;
}

export interface NavOpts {
  routes: NavRoute[];
  active: string;
  right?: (Node | string)[];
}

export function Nav(opts: NavOpts): HTMLElement {
  const links = h('nav', { class: 'nav__links' });
  for (const r of opts.routes) {
    const a = h('a', { class: 'nav__link', href: r.href }, r.label);
    if (opts.active === r.href || opts.active.startsWith(r.href + '/')) a.setAttribute('aria-current', 'page');
    links.append(a);
  }
  return h(
    'header',
    { class: 'nav' },
    h('a', { class: 'nav__brand', href: '#/', html: 'Tether' }),
    links,
    h('span', { class: 'spacer' }),
    ...(opts.right ?? []),
  );
}
