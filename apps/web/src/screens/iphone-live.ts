import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Banner } from '../ui/toast.ts';
import { BridgeClient } from '../iphone-bridge.ts';
import type { Screen } from '../app.ts';

/** Live iPhone view: the WDA MJPEG stream in a fitted box, with pointer →
 *  tap/drag and typing forwarded to the bridge as normalized coordinates. */
export const IphoneLiveScreen: Screen = (root, ctx) => {
  const base = ctx.settings.bridgeBase;
  const token = ctx.settings.bridgeToken;
  if (!base || !token) {
    ctx.router.navigate('/iphone/setup');
    return () => {};
  }
  const client = new BridgeClient(base, token);

  const img = h('img', { alt: 'iPhone screen', style: 'display:block;width:100%;max-height:78vh;object-fit:contain' }) as HTMLImageElement;
  img.src = client.streamUrl();
  const overlay = h('div', { class: 'stage__overlay', tabindex: '0', 'aria-label': 'iPhone control surface' });
  const hint = h('div', { class: 'stage__hint' }, 'tap, drag, and type — controls the iPhone');
  const stage = h('div', { class: 'stage' }, img, overlay, hint);

  const norm = (clientX: number, clientY: number) => {
    const r = img.getBoundingClientRect();
    // The image is object-fit:contain, so compute the letterboxed content box.
    const ar = (img.naturalWidth || 9) / (img.naturalHeight || 19.5);
    let w = r.width;
    let hgt = r.width / ar;
    if (hgt > r.height) {
      hgt = r.height;
      w = r.height * ar;
    }
    const ox = r.left + (r.width - w) / 2;
    const oy = r.top + (r.height - hgt) / 2;
    return { x: Math.min(1, Math.max(0, (clientX - ox) / w)), y: Math.min(1, Math.max(0, (clientY - oy) / hgt)) };
  };

  let down: { x: number; y: number; t: number } | null = null;
  overlay.addEventListener('pointerdown', (e) => {
    down = { ...norm(e.clientX, e.clientY), t: performance.now() };
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!down) return;
    const up = norm(e.clientX, e.clientY);
    const dist = Math.hypot(up.x - down.x, up.y - down.y);
    if (dist < 0.02) void client.tap(down.x, down.y);
    else void client.drag(down.x, down.y, up.x, up.y, Math.min(1, (performance.now() - down.t) / 1000));
    down = null;
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') {
      e.preventDefault();
      void client.keys(e.key === 'Enter' ? '\n' : e.key);
    }
  });

  root.replaceChildren(
    h('div', { class: 'col' },
      h('div', { class: 'row' },
        h('h1', {}, 'iPhone · live'),
        h('span', { class: 'pill', 'data-tone': 'secure' }, h('span', { class: 'pill__dot' }), 'USB · WebDriverAgent'),
        h('span', { class: 'spacer' }),
        Button({ label: 'Home', onClick: () => void client.button('home') }),
        Button({ label: 'Stop bridge', variant: 'danger', onClick: () => { void client.stop(); ctx.router.navigate('/iphone/setup'); } }),
      ),
      Banner({ tone: 'info', message: 'Taps, drags, and typing are injected on the phone via WebDriverAgent. If the image is blank, the stream or the runner is not up — check setup.' }),
      stage,
      Card({ title: 'How this works', children: [
        h('p', { class: 'muted', style: 'font-size:var(--fs-sm)' }, 'The bridge forwards the phone screen as MJPEG and injects XCTest-synthesized touches over USB. Coordinates are sent as fractions and scaled to device points by the bridge.'),
      ] }),
    ),
  );
  overlay.focus();
  return () => {
    img.src = ''; // stop the MJPEG connection on leave
  };
};
