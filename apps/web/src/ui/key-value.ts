import { h } from './dom.ts';

export type KVRow = [key: string, value: Node | string, opts?: { mono?: boolean }];

export function KeyValue(rows: KVRow[]): HTMLElement {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v, o] of rows) {
    dl.append(h('dt', {}, k), h('dd', { class: o?.mono ? 'mono' : undefined }, v));
  }
  return dl;
}
