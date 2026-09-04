import { h } from './dom.ts';

export function Skeleton(opts: { lines?: number; width?: string } = {}): HTMLElement {
  const n = opts.lines ?? 3;
  const wrap = h('div', { class: 'skel-group' });
  for (let i = 0; i < n; i++) {
    const w = i === n - 1 ? '60%' : (opts.width ?? '100%');
    wrap.append(h('div', { class: 'skel', style: `width:${w}` }));
  }
  return wrap;
}
