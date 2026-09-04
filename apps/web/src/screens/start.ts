import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Fingerprint } from '../ui/fingerprint.ts';
import { icons, type IconName } from '../ui/icons.ts';
import { canShareScreen, type Mode } from '../capabilities.ts';
import { launchDemo } from '../app/demo-launch.ts';
import type { AppContext } from '../app/context.ts';
import type { Screen } from '../app.ts';

interface ModeDef {
  mode: Mode | 'iphone';
  icon: IconName;
  title: string;
  desc: string;
  disabled?: boolean;
}

export const StartScreen: Screen = (root, ctx) => {
  const demo = ctx.store.get().config.demo;
  const modes: ModeDef[] = [
    { mode: 'view', icon: 'monitor', title: "View a device's screen", desc: "Watch another device's screen live." },
    {
      mode: 'share',
      icon: 'share',
      title: 'Share this screen',
      desc: canShareScreen ? 'Show this screen to a paired device.' : 'Needs Chrome/Edge opened via http://localhost.',
      disabled: !canShareScreen,
    },
    { mode: 'iphone', icon: 'phone', title: 'Control an iPhone', desc: 'Drive an iPhone over USB (bridge required).' },
    { mode: 'text', icon: 'message', title: 'Send text / clipboard', desc: 'Encrypted messages, both ways.' },
  ];

  root.replaceChildren(
    h(
      'div',
      { class: 'col' },
      h('div', { class: 'eyebrow' }, 'Encrypted cross-device continuity'),
      h('h1', { style: 'font-size:var(--fs-2xl);margin:var(--sp-1) 0' }, 'Pair two devices. See one screen on the other.'),
      h(
        'p',
        { class: 'muted', style: 'max-width:62ch;margin:0' },
        'Devices pair over a Noise-encrypted channel and stream screen video peer-to-peer over WebRTC. The server only relays sealed blobs and never holds a key that can decrypt a session.',
      ),
      h(
        'div',
        { class: 'row', style: 'margin:var(--sp-4) 0 var(--sp-2)' },
        Button({ label: 'Pair a device', variant: 'primary', icon: 'link', testid: 'pair', onClick: () => ctx.router.navigate('/pair/host?mode=view') }),
        Button({ label: 'Try the demo', icon: 'monitor', testid: 'try-demo', onClick: () => void launchDemo(ctx) }),
      ),
      demo ? h('p', { class: 'dim', style: 'font-size:var(--fs-sm)' }, 'Demo mode is on — a virtual device is available with no second machine.') : '',
      h('div', { class: 'eyebrow', style: 'margin-top:var(--sp-5)' }, 'What do you want to do?'),
      h('div', { class: 'modes' }, ...modes.map((d) => modeCard(ctx, d))),
      h(
        'div',
        { class: 'row', style: 'margin-top:var(--sp-5)' },
        h('span', { class: 'dim', style: 'font-size:var(--fs-sm)' }, 'This device'),
        Fingerprint(ctx.myId, { copyable: true }),
      ),
    ),
  );
  return () => {};
};

function modeCard(ctx: AppContext, d: ModeDef): HTMLElement {
  return h(
    'button',
    {
      class: 'mode',
      disabled: d.disabled,
      'data-testid': `mode-${d.mode}`,
      onClick: () => {
        if (d.disabled) return;
        if (d.mode === 'iphone') ctx.router.navigate('/iphone/setup');
        else ctx.router.navigate(`/pair/host?mode=${d.mode}`);
      },
    },
    h('div', { class: 'mode__icon', html: icons[d.icon] }),
    h('div', { class: 'mode__title' }, d.title),
    h('div', { class: 'mode__desc' }, d.desc),
  );
}
