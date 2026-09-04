/**
 * Stage-1 boot. A deliberately small, single-view app that proves the whole
 * pipeline end to end: identity → broker → Noise handshake → WebRTC view, plus
 * demo mode and real failure states. Stage 3 replaces this with a hash router
 * and the full set of screens; the modules it imports (broker-client,
 * secure-link, rtc, demo/*) are the ones that stay.
 */

import './ui/tokens.css';
import { displayFingerprint, type DeviceCapabilities } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from './identity-store.ts';
import { deviceIdFromPublicKey } from './crypto-noble.ts';
import { BrokerClient } from './broker-client.ts';
import { SecureLink, type HandshakeStep, type LinkEvent } from './secure-link.ts';
import { ScreenShareSink, RtcStatsSampler, fetchIceServers, type RtcStats } from './rtc.ts';
import { decodeControl, encodeControl, type ControlMessage } from './control.ts';
import { browserCapabilities } from './capabilities.ts';
import { parsePairFragment, type PairBlob } from './pairing.ts';
import { fromB64 } from './b64.ts';
import { FakeDesktop } from './demo/fake-desktop.ts';
import { VirtualDevice, DEMO_DEVICE_NAME } from './demo/virtual-device.ts';
import { rememberPeer } from './known-peers.ts';

const identity = loadOrCreateIdentity();
const myId = deviceIdFromPublicKey(identity.publicKey);
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const serverUrl = `${wsProto}://${location.host}/signal`;

const STEP_COPY: Record<HandshakeStep, string> = {
  register: 'Prove identity to the broker: the public key hashes (SHA-256, base32) to the device id.',
  watch: 'Ask the broker to signal when the peer is online. No key material moves.',
  msg1: "Noise_IK message 1: our ephemeral key, plus our static key encrypted to the host's public key.",
  msg2: 'Message 2: the host ephemeral key. Three X25519 agreements feed a BLAKE2s KDF; both sides share session keys.',
  verified: 'The authenticated key hashes to the expected fingerprint. Split into two ChaCha20-Poly1305 ciphers.',
};
const STEPS: HandshakeStep[] = ['register', 'watch', 'msg1', 'msg2', 'verified'];

const app = document.getElementById('app')!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  for (const c of kids) n.append(c);
  return n;
}

function renderHome(config: { demo: boolean }): void {
  app.replaceChildren();
  app.append(
    el('header', { class: 'row' },
      el('h1', {}, 'Tether'),
      el('span', { class: 'pill', 'data-testid': 'my-fp', title: myId }, displayFingerprint(myId)),
    ),
    el('p', { style: 'color:var(--fg-1);max-width:60ch' },
      'Pair two devices over an end-to-end encrypted channel, then view one screen live on the other.'),
  );
  const actions = el('div', { class: 'row', style: 'margin-top:16px' });
  const demoBtn = el('button', { class: 'primary', 'data-testid': 'try-demo' }, 'Try the demo');
  demoBtn.onclick = () => startDemo();
  const hostBtn = el('button', { 'data-testid': 'host' }, 'Show pairing code (host)');
  hostBtn.onclick = () => startHost();
  actions.append(demoBtn, hostBtn);
  app.append(actions);
  if (config.demo) startDemo();
}

function renderSession(title: string): {
  pill: HTMLElement;
  steps: Record<HandshakeStep, HTMLElement>;
  video: HTMLVideoElement;
  banner: (msg: string) => void;
  stats: (s: RtcStats) => void;
  log: (line: string) => void;
} {
  app.replaceChildren();
  const pill = el('span', { class: 'pill', 'data-testid': 'link-pill' }, 'connecting…');
  app.append(el('header', { class: 'row' }, el('h1', {}, 'Tether'), pill, el('span', { class: 'pill' }, title)));

  const tl = el('ul', { class: 'timeline' });
  const steps = {} as Record<HandshakeStep, HTMLElement>;
  for (const s of STEPS) {
    const li = el('li', { 'data-testid': `hs-step-${s}`, 'data-status': 'pending' },
      el('span', { class: 'dot' }),
      el('div', {}, el('strong', {}, s), el('small', {}, STEP_COPY[s])));
    steps[s] = li;
    tl.append(li);
  }
  const card = el('div', { class: 'card' }, el('h2', {}, 'Handshake'), tl);
  const video = el('video', { 'data-testid': 'remote-video', autoplay: '', muted: '', playsinline: '' }) as HTMLVideoElement;
  video.muted = true;
  const bannerHost = el('div', {});
  const statsDl = el('dl', { class: 'kv' });
  const statsCard = el('div', { class: 'card', hidden: '' }, el('h2', {}, 'Connection'), statsDl);
  app.append(bannerHost, card, video, statsCard);

  return {
    pill,
    steps,
    video,
    banner: (msg: string) => bannerHost.replaceChildren(el('div', { class: 'banner', 'data-testid': 'fault' }, msg)),
    stats: (s: RtcStats) => {
      statsCard.hidden = false;
      const rows: [string, string][] = [
        ['round-trip', s.rttMs != null ? `${s.rttMs} ms` : '—'],
        ['bitrate', s.kbps != null ? `${s.kbps} kbps` : '—'],
        ['frame rate', s.fps != null ? `${s.fps} fps` : '—'],
        ['resolution', s.width ? `${s.width}×${s.height}` : '—'],
        ['ICE path', s.candidateType ?? '—'],
        ['DTLS', s.dtlsState ?? '—'],
      ];
      statsDl.replaceChildren();
      for (const [k, v] of rows) {
        statsDl.append(el('dt', {}, k), el('dd', { 'data-testid': k === 'ICE path' ? 'stat-candidate' : '' }, v));
      }
    },
    log: (line: string) => console.debug('[link]', line),
  };
}

function setPill(pill: HTMLElement, tone: string, text: string): void {
  pill.setAttribute('data-tone', tone);
  pill.textContent = text;
}

function applyLinkEvent(ui: ReturnType<typeof renderSession>, e: LinkEvent, onPaired: (link: SecureLink) => void, link: SecureLink): void {
  if (e.t === 'handshake') {
    ui.steps[e.step].setAttribute('data-status', e.status);
  } else if (e.t === 'state') {
    if (e.state === 'paired') {
      setPill(ui.pill, 'secure', 'connected & verified');
      onPaired(link);
    } else if (e.state === 'failed') {
      setPill(ui.pill, 'fault', 'failed');
      if (e.fault) ui.banner(e.fault.message);
    } else if (e.state === 'degraded') {
      setPill(ui.pill, 'warn', 'peer disconnected — reconnecting');
    } else if (e.state === 'waiting-peer') {
      setPill(ui.pill, 'info', 'waiting for the peer…');
    } else if (e.state === 'handshaking' || e.state === 'registering') {
      setPill(ui.pill, 'info', 'connecting…');
    }
  }
}

async function startInitiator(peer: PairBlob, title: string): Promise<void> {
  const caps: DeviceCapabilities = browserCapabilities('view');
  const client = new BrokerClient({ serverUrl, staticKeypair: identity, deviceId: myId, capabilities: caps, reconnect: true });
  const ui = renderSession(title);

  const sink = new ScreenShareSink(
    (m) => link.send(encodeControl(m)),
    (stream) => {
      ui.video.srcObject = stream;
      void ui.video.play().catch(() => {});
      if (sinkSampler) sinkSampler.stop();
      sinkSampler = new RtcStatsSampler(sink.pc!, ui.stats, 'inbound');
      sinkSampler.start();
    },
    (reason) => ui.log(`view ended: ${reason}`),
    (reason) => ui.banner(`session refused: ${reason}`),
  );
  let sinkSampler: RtcStatsSampler | null = null;
  let peerCaps: DeviceCapabilities | null = null;

  const link = new SecureLink(client, identity, {
    role: 'initiator',
    peerStatic: fromB64(peer.key),
    peerDeviceId: peer.id,
    onEvent: (e) => {
      if (e.t === 'message') void onControl(decodeControl(e.plaintext));
      applyLinkEvent(ui, e, onPaired, link);
    },
  });

  async function onControl(msg: ControlMessage | null): Promise<void> {
    if (!msg) return;
    if (msg.t === 'hello') { peerCaps = msg.capabilities; return; }
    if (msg.t === 'session-offer') {
      await sink.handleOffer(msg, await fetchIceServers(link.sessionToken), {
        localCaps: caps, peerCaps, localId: myId, peerId: link.peerId ?? peer.id,
      });
      return;
    }
    if (msg.t === 'ice-candidate' || msg.t === 'session-close') { await sink.handle(msg); return; }
  }

  function onPaired(l: SecureLink): void {
    l.send(encodeControl({ t: 'hello', name: 'This browser', capabilities: caps, app: 'web' }));
    l.send(encodeControl({ t: 'view-request', mode: 'view' }));
    if (l.peerPublicKey && l.peerId) {
      rememberPeer(l.peerId, l.peerPublicKey, title === 'demo' ? DEMO_DEVICE_NAME : 'Paired device',
        { verifiedBy: title === 'demo' ? 'demo' : 'qr', demo: title === 'demo' });
    }
  }

  try {
    await client.connect();
  } catch {
    ui.banner('Cannot reach the broker. Is the server running?');
    return;
  }
  void link.pair();
}

async function startDemo(): Promise<void> {
  const desktop = new FakeDesktop();
  const virtual = new VirtualDevice(serverUrl, desktop);
  await virtual.start();
  await startInitiator(virtual.pairBlob, 'demo');
}

function startHost(): void {
  // Host (responder) flow lands in Stage 3 with the full Pairing screen + QR.
  // For Stage 1, direct users to demo mode or two-device LAN via a code (Stage 3).
  app.append(el('div', { class: 'banner', style: 'border-color:var(--info);color:var(--info);background:rgba(127,178,255,.08)' },
    'Hosting UI (QR + join code) arrives with the full pairing screen. Use "Try the demo" to see the flow now.'));
}

async function boot(): Promise<void> {
  let config = { demo: false };
  try {
    config = (await (await fetch('/config')).json()) as { demo: boolean };
  } catch {
    /* default */
  }
  const fragment = parsePairFragment(location.hash);
  if (fragment) {
    await startInitiator(fragment, 'client');
  } else {
    renderHome(config);
  }
}

void boot();
