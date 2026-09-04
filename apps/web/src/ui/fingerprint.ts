import { h } from './dom.ts';
import { icons } from './icons.ts';
import { displayFingerprint } from '@tether/protocol/browser';

export interface FingerprintOpts {
  label?: string;
  /** When set, each 7-char block is colored by whether it matches this id. */
  compareWith?: string;
  copyable?: boolean;
}

/** Render a device id as grouped, mono 7-char blocks, optionally comparing it
 *  block-by-block against another id (the pairing trust check). */
export function Fingerprint(id: string, opts: FingerprintOpts = {}): HTMLElement {
  const groups = displayFingerprint(id).split('-');
  const other = opts.compareWith ? displayFingerprint(opts.compareWith).split('-') : null;
  const wrap = h('span', { class: 'fp' });
  groups.forEach((g, i) => {
    let cls = 'fp__block';
    if (other) cls += other[i] === g ? ' fp__block--match' : ' fp__block--mismatch';
    wrap.append(h('span', { class: cls }, g));
  });
  if (opts.copyable) {
    wrap.append(
      h('button', {
        class: 'fp__copy',
        title: 'Copy fingerprint',
        'aria-label': 'Copy fingerprint',
        html: icons.copy,
        onClick: () => void navigator.clipboard?.writeText(id).catch(() => {}),
      }),
    );
  }
  return opts.label ? h('span', { class: 'row' }, h('span', { class: 'dim' }, opts.label), wrap) : wrap;
}
