import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Fingerprint } from '../ui/fingerprint.ts';
import { confirm } from '../ui/modal.ts';
import { toast } from '../ui/toast.ts';
import { clearKnownPeers } from '../known-peers.ts';
import { exportIdentitySeed, regenerateIdentity } from '../identity-store.ts';
import { defaultDeviceName, type Theme } from '../app/settings.ts';
import type { Screen } from '../app.ts';

export const SettingsScreen: Screen = (root, ctx) => {
  const s = ctx.settings;

  const nameInput = h('input', { class: 'input', value: s.deviceName, placeholder: defaultDeviceName(), style: 'max-width:280px' }) as HTMLInputElement;
  nameInput.addEventListener('change', () => ctx.saveSettings({ deviceName: nameInput.value.trim() }));

  const themeSel = h('select', { class: 'input', style: 'max-width:160px' },
    ...(['system', 'dark', 'light'] as Theme[]).map((t) => h('option', { value: t, selected: s.theme === t }, t)),
  ) as HTMLSelectElement;
  themeSel.addEventListener('change', () => ctx.saveSettings({ theme: themeSel.value as Theme }));

  const brokerInput = h('input', { class: 'input mono', value: s.brokerUrl, placeholder: 'wss://your-broker/signal (default: this server)', style: 'flex:1' }) as HTMLInputElement;
  brokerInput.addEventListener('change', () => ctx.saveSettings({ brokerUrl: brokerInput.value.trim() }));

  const exportIdentity = () => {
    const seed = exportIdentitySeed();
    if (!seed) {
      toast('warn', 'No stored identity to export (private browsing?).');
      return;
    }
    const blob = new Blob([seed], { type: 'text/plain' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'tether-identity.txt' }) as HTMLAnchorElement;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const regen = async () => {
    if (await confirm({ title: 'Regenerate identity?', body: 'This device gets a new fingerprint. Every device you paired with must pair again. This cannot be undone.', confirmLabel: 'Regenerate', danger: true })) {
      regenerateIdentity();
      toast('secure', 'New identity created. Reload to use it.');
    }
  };

  const clearPeers = async () => {
    if (await confirm({ title: 'Clear paired devices?', body: 'Removes all remembered devices from this browser.', confirmLabel: 'Clear', danger: true })) {
      clearKnownPeers();
      toast('secure', 'Paired devices cleared.');
    }
  };

  root.replaceChildren(
    h('div', { class: 'col' },
      h('h1', {}, 'Settings'),
      Card({ title: 'This device', children: [
        field('Device name', nameInput),
        h('div', { class: 'field' }, h('label', {}, 'Fingerprint'), Fingerprint(ctx.myId, { copyable: true })),
        h('div', { class: 'row' },
          Button({ label: 'Export identity', onClick: exportIdentity }),
          Button({ label: 'Regenerate identity', variant: 'danger', onClick: () => void regen() }),
        ),
      ] }),
      Card({ title: 'Appearance', children: [field('Theme', themeSel)] }),
      Card({ title: 'Paired devices', children: [Button({ label: 'Clear all paired devices', variant: 'danger', onClick: () => void clearPeers() })] }),
      Card({ title: 'Advanced', children: [
        field('Broker URL', brokerInput),
        h('p', { class: 'dim', style: 'font-size:var(--fs-xs)' }, 'Leave blank to use this server. Changing it takes effect on reload.'),
      ] }),
    ),
  );
  return () => {};
};

function field(label: string, control: HTMLElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', {}, label), control);
}
