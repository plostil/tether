import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { StatusPill } from '../ui/status-pill.ts';
import { Fingerprint } from '../ui/fingerprint.ts';
import { HandshakeTimeline } from '../ui/handshake-timeline.ts';
import { KeyValue } from '../ui/key-value.ts';
import { Skeleton } from '../ui/skeleton.ts';
import { Banner, toast } from '../ui/toast.ts';
import { confirm } from '../ui/modal.ts';
import type { Screen } from '../app.ts';

/** Hidden route (#/kitchen-sink) — every component in every state, for review
 *  and screenshots. Not linked from the nav. */
export const KitchenSink: Screen = (root, ctx) => {
  const tl = HandshakeTimeline();
  tl.set('register', 'done'); tl.set('watch', 'done'); tl.set('msg1', 'done'); tl.set('msg2', 'active');
  const pills = h('div', { class: 'row' });
  (['neutral', 'info', 'secure', 'warn', 'fault'] as const).forEach((tone) => {
    const p = StatusPill(tone); p.set(tone, tone); pills.append(p.el);
  });
  const id = ctx.myId;
  const other = id.slice(0, 20) + 'XXXXX' + id.slice(25);
  root.replaceChildren(
    h('div', { class: 'col' },
      h('h1', {}, 'Kitchen sink'),
      Card({ title: 'Buttons', children: [h('div', { class: 'row' },
        Button({ label: 'Primary', variant: 'primary', icon: 'link' }),
        Button({ label: 'Secondary' }),
        Button({ label: 'Danger', variant: 'danger', icon: 'x' }),
        Button({ label: 'Ghost', variant: 'ghost' }),
        Button({ label: 'Disabled', disabled: true }),
      )] }),
      Card({ title: 'Status pills', children: [pills] }),
      Card({ title: 'Fingerprint (plain / compare)', children: [
        Fingerprint(id, { copyable: true }),
        h('div', { style: 'margin-top:var(--sp-2)' }, Fingerprint(id, { compareWith: other })),
      ] }),
      Card({ title: 'Handshake timeline', children: [tl.el] }),
      Card({ title: 'Key / value', children: [KeyValue([
        ['round-trip', '12 ms', { mono: true }], ['cipher suite', 'Noise_IK_25519_ChaChaPoly_BLAKE2s', { mono: true }], ['ICE path', 'host', { mono: true }],
      ])] }),
      Card({ title: 'Skeleton', children: [Skeleton({ lines: 3 })] }),
      Banner({ tone: 'fault', message: 'A fault banner with a retry.', actions: [Button({ label: 'Retry' })] }),
      Banner({ tone: 'warn', message: 'A warning banner.' }),
      Banner({ tone: 'info', message: 'An info banner.' }),
      h('div', { class: 'row' },
        Button({ label: 'Toast', onClick: () => toast('secure', 'A phosphor-green toast.') }),
        Button({ label: 'Confirm modal', onClick: () => void confirm({ title: 'Confirm something?', body: 'This is a focus-trapped dialog.', danger: true }) }),
      ),
    ),
  );
  return () => {};
};
