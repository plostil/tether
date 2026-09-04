import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Banner } from '../ui/toast.ts';
import { icons } from '../ui/icons.ts';
import { BridgeClient } from '../iphone-bridge.ts';
import type { BridgeSnapshot } from '../iphone-types.ts';
import type { Screen } from '../app.ts';

/** Live prerequisite checklist for the USB iPhone bridge, driven by SSE from
 *  apps/ios-bridge. The bridge prints a URL with ?bridge= and ?token=; those
 *  are stored in settings on first visit. */
export const IphoneSetupScreen: Screen = (root, ctx, route) => {
  // Capture bridge coordinates from the query the CLI printed.
  const qBase = route.query.get('bridge');
  const qToken = route.query.get('token');
  if (qBase && qToken && (qBase !== ctx.settings.bridgeBase || qToken !== ctx.settings.bridgeToken)) {
    ctx.saveSettings({ bridgeBase: qBase, bridgeToken: qToken });
  }
  const base = ctx.settings.bridgeBase;
  const token = ctx.settings.bridgeToken;

  if (!base || !token) {
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'eyebrow' }, 'Control an iPhone'),
        h('h1', {}, 'Start the bridge'),
        Banner({ tone: 'info', message: 'Run the local bridge on this PC, then open the setup link it prints.' }),
        Card({ title: 'Run this', children: [
          h('pre', { class: 'mono', style: 'white-space:pre-wrap;font-size:var(--fs-sm)' }, 'npm start -w apps/ios-bridge'),
          h('p', { class: 'muted', style: 'font-size:var(--fs-sm)' }, 'It prints a link like /#/iphone/setup?bridge=…&token=…. Open that link here. Full setup: docs/IOS-CONTROL.md.'),
        ] }),
        h('div', {}, Button({ label: 'Back', variant: 'ghost', onClick: () => ctx.router.navigate('/') })),
      ),
    );
    return () => {};
  }

  const client = new BridgeClient(base, token);
  let snap: BridgeSnapshot | null = null;

  const startBtn = Button({
    label: 'Start bridge',
    variant: 'primary',
    onClick: () => void client.start(),
  });

  const paint = () => {
    const allOk = snap ? snap.prereqs.every((p) => p.ok) : false;
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'eyebrow' }, 'Control an iPhone'),
        h('div', { class: 'row' }, h('h1', {}, 'iPhone bridge setup'),
          h('span', { class: 'spacer' }),
          snap ? h('span', { class: 'pill', 'data-tone': phaseTone(snap.phase) }, h('span', { class: 'pill__dot' }), snap.phase) : ''),
        !snap ? Banner({ tone: 'warn', message: `Cannot reach the bridge at ${base}. Is it running?` }) : '',
        snap?.error ? Banner({ tone: 'fault', message: snap.error }) : '',
        Card({ title: 'Prerequisites', children: [
          h('div', { class: 'col', style: 'gap:var(--sp-2)' },
            ...(snap?.prereqs ?? []).map(checkRow)),
        ] }),
        snap && snap.processes.length
          ? Card({ title: 'Bringing up WebDriverAgent', children: [
              h('div', { class: 'col', style: 'gap:var(--sp-2)' }, ...snap.processes.map(procRow)),
            ] })
          : '',
        h('div', { class: 'row' },
          startBtn,
          snap?.phase === 'running' ? Button({ label: 'Open live view', variant: 'primary', onClick: () => ctx.router.navigate('/iphone/live') }) : '',
          Button({ label: 'Back', variant: 'ghost', onClick: () => ctx.router.navigate('/') }),
        ),
        h('p', { class: 'dim', style: 'font-size:var(--fs-xs)' }, allOk ? 'All checks pass — Start the bridge.' : 'Resolve the red items, then Start. See docs/IOS-CONTROL.md.'),
      ),
    );
    startBtn.disabled = snap?.phase === 'starting' || snap?.phase === 'running';
    if (snap?.phase === 'running') ctx.router.navigate('/iphone/live');
  };

  // Prime with a one-shot status, then live updates over SSE.
  void client.status().then((s) => { snap = s; paint(); });
  const off = client.events((s) => { snap = s; paint(); });
  paint();
  return off;
};

function checkRow(p: BridgeSnapshot['prereqs'][number]): HTMLElement {
  return h('div', { class: 'device', style: 'padding:var(--sp-2) 0' },
    h('span', { class: 'pill', 'data-tone': p.ok ? 'secure' : 'fault' }, h('span', { class: 'pill__dot' }), p.ok ? 'ok' : 'fix'),
    h('div', { class: 'device__main' },
      h('div', { class: 'device__name' }, p.label),
      h('div', { class: 'device__meta' }, p.detail),
      p.ok ? '' : h('div', { class: 'dim', style: 'font-size:var(--fs-xs);margin-top:2px' }, p.fix),
    ),
  );
}

function procRow(p: BridgeSnapshot['processes'][number]): HTMLElement {
  return h('div', { class: 'device', style: 'padding:var(--sp-2) 0;align-items:flex-start' },
    h('span', { class: 'pill', 'data-tone': p.state === 'running' ? 'secure' : p.state === 'failed' ? 'fault' : 'info' }, h('span', { class: 'pill__dot' }), p.state),
    h('div', { class: 'device__main' },
      h('div', { class: 'device__name mono' }, p.name),
      h('div', { class: 'device__meta', style: 'white-space:pre-wrap' }, p.logTail.slice(-3).join('\n')),
    ),
  );
}

function phaseTone(phase: string): string {
  return phase === 'running' ? 'secure' : phase === 'failed' ? 'fault' : phase === 'idle' ? 'neutral' : 'info';
}

void icons;
