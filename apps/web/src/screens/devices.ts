import { h } from '../ui/dom.ts';
import { Button } from '../ui/button.ts';
import { Card } from '../ui/card.ts';
import { Fingerprint } from '../ui/fingerprint.ts';
import { confirm } from '../ui/modal.ts';
import { icons } from '../ui/icons.ts';
import { listKnownPeers, forgetPeer, renamePeer, peerKeyBytes, type KnownPeer } from '../known-peers.ts';
import { toB64 } from '../b64.ts';
import { launchDemo } from '../app/demo-launch.ts';
import type { AppContext } from '../app/context.ts';
import type { Screen } from '../app.ts';

export const DevicesScreen: Screen = (root, ctx) => {
  const paint = () => {
    const peers = listKnownPeers();
    const presence = ctx.store.get().presence;
    root.replaceChildren(
      h('div', { class: 'col' },
        h('div', { class: 'row' }, h('h1', {}, 'Devices'), h('span', { class: 'spacer' }),
          Button({ label: 'Pair a device', variant: 'primary', icon: 'plus', onClick: () => ctx.router.navigate('/pair/host?mode=view') })),
        peers.length === 0
          ? Card({ children: [h('div', { class: 'empty' }, h('div', { html: icons.link, style: 'color:var(--fg-2)' }), h('p', {}, 'No paired devices yet.'), Button({ label: 'Try the demo', onClick: () => void launchDemo(ctx) }))] })
          : Card({ children: peers.map((p) => deviceRow(ctx, p, presence[p.id] === true, paint)) }),
      ),
    );
  };
  const off = ctx.store.subscribe(paint);
  paint();
  return off;
};

function deviceRow(ctx: AppContext, peer: KnownPeer, online: boolean, refresh: () => void): HTMLElement {
  const connect = () => {
    if (peer.demo) {
      void launchDemo(ctx);
      return;
    }
    ctx.session.start({
      role: 'initiator',
      peer: { id: peer.id, key: peer.key },
      mode: 'view',
      label: peer.label,
      verifiedBy: peer.verifiedBy,
      demo: peer.demo,
    });
    ctx.router.navigate('/live');
  };
  const rename = async () => {
    const name = prompt('Rename device', peer.label);
    if (name) {
      renamePeer(peer.id, name);
      refresh();
    }
  };
  const unpair = async () => {
    if (await confirm({ title: `Unpair ${peer.label}?`, body: 'You will need to pair again to reconnect.', confirmLabel: 'Unpair', danger: true })) {
      forgetPeer(peer.id);
      refresh();
    }
  };
  void peerKeyBytes;
  void toB64;
  return h('div', { class: 'device' },
    h('span', { class: 'pill', 'data-tone': online ? 'secure' : 'neutral' }, h('span', { class: 'pill__dot' }), online ? 'online' : 'offline'),
    h('div', { class: 'device__main' },
      h('div', { class: 'device__name' }, peer.label),
      h('div', { class: 'device__meta' }, `${peer.id.slice(0, 12)}… · seen ${relTime(peer.lastSeen)}${peer.verifiedBy ? ` · via ${peer.verifiedBy}` : ''}`),
    ),
    Button({ label: 'Connect', variant: 'primary', onClick: connect }),
    Button({ label: 'Rename', variant: 'ghost', onClick: () => void rename() }),
    Button({ label: 'Unpair', variant: 'danger', onClick: () => void unpair() }),
  );
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
