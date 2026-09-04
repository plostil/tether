import { h } from './dom.ts';
import { icons, type IconName } from './icons.ts';

export interface ButtonOpts {
  label: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: IconName;
  onClick?: () => void;
  disabled?: boolean;
  testid?: string;
}

export function Button(opts: ButtonOpts): HTMLButtonElement {
  const cls = `btn${opts.variant && opts.variant !== 'secondary' ? ` btn--${opts.variant}` : ''}`;
  const btn = h('button', {
    class: cls,
    type: 'button',
    disabled: opts.disabled,
    'data-testid': opts.testid,
    onClick: () => opts.onClick?.(),
  });
  if (opts.icon) btn.append(h('span', { class: 'btn__icon', html: icons[opts.icon] }));
  btn.append(opts.label);
  return btn;
}

/** Put a button into a spinner/busy state; returns a restore function. */
export function busy(btn: HTMLButtonElement, label = 'Working…'): () => void {
  const prev = btn.innerHTML;
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'btn__spinner' }), label);
  return () => {
    btn.disabled = wasDisabled;
    btn.innerHTML = prev;
  };
}
