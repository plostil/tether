import { PROTOCOL_NAME } from '@tether/protocol/browser';
import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { KeyValue } from '../ui/key-value.ts';
import { Banner } from '../ui/toast.ts';
import { Skeleton } from '../ui/skeleton.ts';
import { confirm } from '../ui/modal.ts';
import { HandshakeTimeline } from '../ui/handshake-timeline.ts';
import { stopDemo } from '../app/demo-launch.ts';
import type { AppContext } from '../app/context.ts';
import type { Screen } from '../app.ts';
import type { HandshakeStep, StepStatus } from '../secure-link.ts';

const STEPS: HandshakeStep[] = ['register', 'watch', 'msg1', 'msg2', 'verified'];

export const LiveScreen: Screen = (root, ctx) => {
  if (!ctx.session.active) {
    root.replaceChildren(
      h('div', { class: 'empty' }, h('p', {}, 'No active session.'), Button({ label: 'Go to Devices', variant: 'primary', onClick: () => ctx.router.navigate('/devices') })),
    );
    return () => {};
  }

  const video = ctx.session.videoEl;
  const stage = h('div', { class: 'stage' }, video);

  // Control overlay for control/iphone modes.
  const mode = ctx.store.get().mode;
  if (mode === 'control') attachControlOverlay(stage, video, ctx);

  const paint = () => {
    const s = ctx.store.get();
    const link = s.link;
    const sess = s.session;
    const peerName = link.peer?.name ?? 'peer';

    const banners: (Node | string)[] = [];
    if (link.state === 'failed' && link.fault) {
      banners.push(Banner({
        tone: 'fault',
        message: link.fault.message,
        actions: link.fault.retryable ? [Button({ label: 'Retry', onClick: () => ctx.session.retry() })] : [],
      }));
    }
    if (link.state === 'degraded') banners.push(Banner({ tone: 'warn', message: `Connection to ${peerName} dropped. Reconnecting…` }));
    if (sess.refused) banners.push(Banner({ tone: 'info', message: sess.refused }));
    if (sess.fault) banners.push(Banner({ tone: 'fault', message: sess.fault }));

    const stats = sess.stats;
    const quality = KeyValue([
      ['round-trip', stats?.rttMs != null ? `${stats.rttMs} ms` : '—', { mono: true }],
      ['bitrate', stats?.kbps != null ? `${stats.kbps} kbps` : '—', { mono: true }],
      ['frame rate', stats?.fps != null ? `${stats.fps} fps` : '—', { mono: true }],
      ['resolution', stats?.width ? `${stats.width}×${stats.height}` : '—', { mono: true }],
      ['ICE path', statCandidate(stats?.candidateType ?? null), { mono: true }],
    ]);
    const encryption = KeyValue([
      ['cipher suite', PROTOCOL_NAME, { mono: true }],
      ['session fingerprint', link.sessionFingerprint ?? '—', { mono: true }],
      ['transport (media)', sess.dtlsState ? `DTLS-SRTP · ${sess.dtlsState}` : 'DTLS-SRTP', { mono: true }],
      ['connection', sess.rtcState ?? (link.state === 'paired' ? 'signalling' : link.state), { mono: true }],
    ]);

    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'row' },
          h('h1', {}, `Live · ${peerName}`),
          h('span', { class: 'pill', 'data-tone': link.state === 'paired' ? 'secure' : link.state === 'degraded' ? 'warn' : 'info', 'data-testid': 'link-pill' },
            h('span', { class: 'pill__dot' }), link.state === 'paired' ? 'connected & verified' : link.state),
          h('span', { class: 'spacer' }),
          Button({ label: 'End session', variant: 'danger', icon: 'x', testid: 'end-session', onClick: () => void end() }),
        ),
        ...banners,
        !sess.hasVideo && link.state === 'paired'
          ? h('div', {}, stage, h('p', { class: 'dim', style: 'font-size:var(--fs-sm)' }, 'Waiting for the screen stream…'))
          : link.state !== 'paired'
            ? Card({ title: 'Handshake', children: [timeline(ctx)] })
            : stage,
        h('div', { class: 'row', style: 'align-items:flex-start;gap:var(--sp-4)' },
          Card({ title: 'Connection quality', children: [sess.stats ? quality : Skeleton({ lines: 4 })] }),
          Card({ title: 'Encryption', children: [encryption] }),
        ),
      ),
    );
  };

  const end = async () => {
    if (await confirm({ title: 'End this session?', body: 'The encrypted link and the screen stream will close.', confirmLabel: 'End session', danger: true })) {
      ctx.session.end();
      stopDemo();
      ctx.router.navigate('/devices');
    }
  };

  const off = ctx.store.subscribe(paint);
  paint();
  return off;
};

function timeline(ctx: AppContext): HTMLElement {
  const tl = HandshakeTimeline();
  const steps = ctx.store.get().link.steps as Partial<Record<HandshakeStep, StepStatus>>;
  for (const s of STEPS) tl.set(s, steps[s] ?? 'pending');
  return tl.el;
}

function statCandidate(t: string | null): Node {
  const label = t ?? '—';
  return h('span', { 'data-testid': 'stat-candidate' }, label === 'host' ? 'host (LAN, direct)' : label === 'relay' ? 'relay (TURN)' : label);
}

function attachControlOverlay(stage: HTMLElement, video: HTMLVideoElement, ctx: AppContext): void {
  const overlay = h('div', { class: 'stage__overlay', tabindex: '0', 'aria-label': 'Control surface' });
  const hint = h('div', { class: 'stage__hint' }, 'controlling — click and type; Esc to release');
  const norm = (e: MouseEvent): { x: number; y: number } => {
    const r = video.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  let last = 0;
  overlay.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - last < 16) return;
    last = now;
    const p = norm(e);
    ctx.session.sendInput({ kind: 'pointer', x: p.x, y: p.y });
  });
  overlay.addEventListener('click', (e) => {
    const p = norm(e);
    ctx.session.sendInput({ kind: 'tap', x: p.x, y: p.y });
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { overlay.blur(); return; }
    if (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter') {
      e.preventDefault();
      ctx.session.sendInput({ kind: 'keys', text: e.key });
    }
  });
  stage.append(overlay, hint);
}
