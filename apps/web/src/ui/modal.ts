import { h } from './dom.ts';
import { Button } from './button.ts';

export interface ConfirmOpts {
  title: string;
  body: string | Node;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

/** A focus-trapped confirm dialog. Resolves true on confirm, false otherwise. */
export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (val: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
      prevFocus?.focus?.();
      resolve(val);
    };
    const confirmBtn = Button({
      label: opts.confirmLabel ?? 'Confirm',
      variant: opts.danger ? 'danger' : 'primary',
      onClick: () => close(true),
    });
    const cancelBtn = Button({ label: opts.cancelLabel ?? 'Cancel', variant: 'ghost', onClick: () => close(false) });
    const dialog = h(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title },
      h('h2', { class: 'modal__title' }, opts.title),
      h('div', { class: 'modal__body' }, opts.body),
      h('div', { class: 'modal__actions' }, cancelBtn, confirmBtn),
    );
    const scrim: HTMLElement = h('div', { class: 'modal__scrim' }, dialog);
    scrim.addEventListener('click', (e) => {
      if (e.target === scrim) close(false);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Tab') {
        const f = dialog.querySelectorAll<HTMLElement>('button');
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    confirmBtn.focus();
  });
}
