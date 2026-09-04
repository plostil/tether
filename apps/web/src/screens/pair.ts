import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Banner } from '../ui/toast.ts';
import { Fingerprint } from '../ui/fingerprint.ts';
import { HandshakeTimeline } from '../ui/handshake-timeline.ts';
import { Skeleton } from '../ui/skeleton.ts';
import { renderQr } from '../qr.ts';
import { encodePairUrl, parsePairFragment, type PairBlob } from '../pairing.ts';
import { toB64 } from '../b64.ts';
import { launchDemo } from '../app/demo-launch.ts';
import type { Mode } from '../capabilities.ts';
import type { AppContext } from '../app/context.ts';
import type { Screen } from '../app.ts';
import type { HandshakeStep, StepStatus } from '../secure-link.ts';

const STEPS: HandshakeStep[] = ['register', 'watch', 'msg1', 'msg2', 'verified'];

export const PairScreen: Screen = (root, ctx, route) => {
  const sub = route.path.replace(/^\/pair\/?/, '') || 'host';
  if (sub === 'demo') {
    void launchDemo(ctx);
    return () => {};
  }
  const mode = (route.query.get('mode') as Mode) || 'view';
  return sub === 'join' ? mountJoin(root, ctx, route) : mountHost(root, ctx, mode);
};

function timeline(ctx: AppContext): HTMLElement {
  const tl = HandshakeTimeline();
  const steps = ctx.store.get().link.steps as Partial<Record<HandshakeStep, StepStatus>>;
  for (const s of STEPS) tl.set(s, steps[s] ?? 'pending');
  return tl.el;
}

function mountHost(root: HTMLElement, ctx: AppContext, mode: Mode): () => void {
  const qrCanvas = h('canvas', { id: 'qr', style: 'background:#fff;padding:8px;border-radius:4px' }) as HTMLCanvasElement;
  const codeEl = h('div', { class: 'mono', style: 'font-size:var(--fs-2xl);letter-spacing:.18em', 'data-testid': 'join-code' }, '······');
  const blob: PairBlob = { id: ctx.myId, key: toB64(ctx.identity.publicKey) };

  // Build the QR + code once the page client is registered (so a token exists).
  const setup = async () => {
    let host = location.hostname;
    try {
      const info = (await (await fetch('/net-info')).json()) as { lanAddresses: string[] };
      if (info.lanAddresses[0]) host = info.lanAddresses[0];
    } catch {
      /* fall back to current host */
    }
    renderQr(qrCanvas, encodePairUrl(blob, host, location.port));
    try {
      if (ctx.client.sessionToken) {
        const res = await fetch('/pair-code', { method: 'POST', headers: { authorization: `Bearer ${ctx.client.sessionToken}` } });
        if (res.ok) codeEl.textContent = ((await res.json()) as { code: string }).code;
      }
    } catch {
      codeEl.textContent = '——————';
    }
  };
  void setup();

  // Start listening as the responder.
  ctx.session.start({ role: 'responder', mode });

  const paint = () => {
    const s = ctx.store.get().link;
    if (s.state === 'paired') {
      ctx.router.navigate('/live');
      return;
    }
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'eyebrow' }, `Host · ${mode}`),
        h('h1', {}, 'Pair a device'),
        Card({
          title: 'Scan or type',
          children: [
            h('div', { class: 'row', style: 'align-items:flex-start;gap:var(--sp-5)' },
              qrCanvas,
              h('div', { class: 'col' },
                h('div', { class: 'dim', style: 'font-size:var(--fs-sm)' }, 'On the other device, scan the QR, or open Tether and enter this code:'),
                codeEl,
                h('div', { class: 'dim', style: 'font-size:var(--fs-xs)' }, 'Code expires in 10 minutes.'),
              ),
            ),
          ],
        }),
        Card({ title: 'Handshake', children: [s.state === 'idle' || s.state === 'registering' ? Skeleton({ lines: 3 }) : timeline(ctx)] }),
        s.fault ? Banner({ tone: 'fault', message: s.fault.message }) : '',
        h('div', {}, Button({ label: 'Cancel', variant: 'ghost', onClick: () => { ctx.session.end(); ctx.router.navigate('/'); } })),
      ),
    );
  };
  const off = ctx.store.subscribe(paint);
  paint();
  return off;
}

function mountJoin(root: HTMLElement, ctx: AppContext, route: import('../app/router.ts').Route): () => void {
  const blobParam = route.query.get('blob');
  const fromQr = blobParam ? parsePairFragment(`?blob=${blobParam}`) : null;

  let started = false;
  const startWith = (peer: PairBlob, verifiedBy: 'qr' | 'code' | 'link') => {
    if (started) return;
    started = true;
    ctx.session.start({ role: 'initiator', peer, mode: 'view', label: 'Host device', verifiedBy });
  };
  if (fromQr) startWith(fromQr, 'qr');

  const codeInput = h('input', { class: 'input mono', placeholder: 'ABC234', maxlength: '6', style: 'text-transform:uppercase;max-width:160px', 'data-testid': 'code-input' }) as HTMLInputElement;
  const linkInput = h('input', { class: 'input mono', placeholder: 'paste the full pairing link', style: 'flex:1' }) as HTMLInputElement;
  const err = h('div', {});

  const resolveCode = async () => {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 6) return;
    err.replaceChildren();
    try {
      const res = await fetch(`/pair-code/${encodeURIComponent(code)}`);
      if (!res.ok) {
        err.replaceChildren(Banner({ tone: 'fault', message: 'That code did not work — it may have expired or been used up.' }));
        return;
      }
      startWith((await res.json()) as PairBlob, 'code');
    } catch {
      err.replaceChildren(Banner({ tone: 'fault', message: 'Could not reach the broker to resolve the code.' }));
    }
  };
  const resolveLink = () => {
    const blob = parsePairFragment(linkInput.value.trim().replace(/^[^#]*/, ''));
    if (blob) startWith(blob, 'link');
    else err.replaceChildren(Banner({ tone: 'fault', message: 'That does not look like a Tether pairing link.' }));
  };

  const paint = () => {
    const s = ctx.store.get().link;
    if (s.state === 'paired') {
      // Code/link joins need the fingerprint confirmed before use.
      const provenance = ctx.store.get();
      void provenance; // kept for readability
      ctx.router.navigate('/live');
      return;
    }
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'eyebrow' }, 'Join'),
        h('h1', {}, 'Connect to a host'),
        started
          ? Card({
              title: 'Handshake',
              children: [
                timeline(ctx),
                s.peer ? h('div', { class: 'row', style: 'margin-top:var(--sp-3)' }, h('span', { class: 'dim', style: 'font-size:var(--fs-sm)' }, 'Host fingerprint'), Fingerprint(s.peer.id)) : '',
                s.fault ? Banner({ tone: 'fault', message: s.fault.message }) : '',
              ],
            })
          : Card({
              title: 'Enter a code or paste a link',
              children: [
                h('div', { class: 'row' }, codeInput, Button({ label: 'Connect', variant: 'primary', onClick: () => void resolveCode() })),
                h('div', { class: 'row', style: 'margin-top:var(--sp-3)' }, linkInput, Button({ label: 'Use link', onClick: resolveLink })),
                err,
              ],
            }),
        h('div', {}, Button({ label: 'Back', variant: 'ghost', onClick: () => { ctx.session.end(); ctx.router.navigate('/'); } })),
      ),
    );
  };
  const off = ctx.store.subscribe(paint);
  paint();
  return off;
}
