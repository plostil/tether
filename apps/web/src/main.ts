/**
 * Web client entry.
 *
 * Pairing role is decided by how the page is opened:
 *   - #pair=<blob> in the URL (from scanning a QR)  -> initiator, connect to that peer.
 *   - a remembered peer chosen on the home screen   -> initiator, no QR needed.
 *   - "Show pairing QR" chosen on the home screen   -> responder (the host/PC).
 *
 * What you can DO once paired is decided by device CAPABILITY, not role, so the
 * link is symmetric where the platform allows it:
 *   - Any browser that supports getDisplayMedia can SHARE its screen.
 *   - Any browser can VIEW the peer's shared screen.
 *   - An encrypted text/clipboard channel runs both ways.
 *
 * Not possible from a browser page (either direction): injecting mouse/keyboard
 * into the other device's OS. That needs the native Android/Windows clients
 * (AccessibilityService / SendInput); the UI says so rather than pretending.
 */

import { displayFingerprint, type SessionOffer } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from './identity-store.ts';
import { deviceIdFromPublicKey } from './crypto-noble.ts';
import { SecureLink } from './secure-link.ts';
import { decodeControl, encodeControl, type ControlMessage } from './control.ts';
import { fetchIceServers, ScreenShareSink, ScreenShareSource } from './rtc.ts';
import { renderQr } from './qr.ts';
import { fromB64, fromB64Url, toB64Url } from './b64.ts';
import { listKnownPeers, peerKeyBytes, rememberPeer, type KnownPeer } from './known-peers.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

function setStatus(text: string, ok = false): void {
  const el = $('status');
  el.textContent = text;
  el.className = ok ? 'ok' : '';
}

function log(line: string): void {
  const div = document.createElement('div');
  div.textContent = line;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
}

function show(id: string): void {
  $(id).hidden = false;
}
function hide(id: string): void {
  $(id).hidden = true;
}

const kp = loadOrCreateIdentity();
const myId = deviceIdFromPublicKey(kp.publicKey);

interface PairBlob {
  id: string;
  key: string;
}

function parsePairFragment(): PairBlob | null {
  const m = location.hash.match(/#pair=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64Url(m[1]!))) as PairBlob;
  } catch {
    return null;
  }
}

// ---- home screen: pick how to connect --------------------------------------

function renderHome(): void {
  $('my-fingerprint').textContent = displayFingerprint(myId);
  const peers = listKnownPeers();
  const list = $('known-list');
  list.innerHTML = '';

  if (peers.length) {
    show('known-panel');
    for (const peer of peers) {
      const btn = document.createElement('button');
      btn.textContent = `Reconnect to ${peer.label}`;
      btn.onclick = () => startInitiator({ id: peer.id, key: peer.key }, peer);
      list.appendChild(btn);
    }
  }
  show('home-actions');
  $<HTMLButtonElement>('host-btn').onclick = () => startResponder();
  setStatus(peers.length ? 'reconnect to a saved device, or host a new pairing' : 'choose how to connect');
}

// ---- connect + run ---------------------------------------------------------

function startInitiator(peer: PairBlob, known?: KnownPeer): void {
  hide('home');
  run('initiator', peer, known?.label ?? 'the host');
}

function startResponder(): void {
  hide('home');
  run('responder');
}

async function run(role: 'initiator' | 'responder', peer?: PairBlob, peerLabel = 'peer'): Promise<void> {
  document.body.dataset.role = role;
  $('role-badge').textContent = role === 'responder' ? 'host' : 'client';
  $('my-fingerprint').textContent = displayFingerprint(myId);
  show('session');

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const link = new SecureLink({
    serverUrl: `${wsProto}://${location.host}/signal`,
    staticKeypair: kp,
    role,
    peerDeviceId: peer?.id,
    peerStatic: peer ? fromB64(peer.key) : undefined,
    log,
    onMessage: (pt) => {
      const msg = decodeControl(pt);
      if (msg) void onControl(msg);
    },
    onPeerStatus: (online) => {
      if (!link.isPaired) setStatus(online ? 'device online, connecting…' : `waiting for ${peerLabel} to come online…`);
    },
  });

  const send = (m: ControlMessage): void => link.send(encodeControl(m));

  // ---- media wiring (symmetric: this page can share AND view) --------------

  const video = $<HTMLVideoElement>('remote-video');
  let source: ScreenShareSource | null = null;
  const sink = new ScreenShareSink(send, video, (reason) => {
    document.body.classList.remove('viewing');
    log(`view ended: ${reason}`);
  });

  async function startShare(): Promise<void> {
    if (source) return;
    if (!canShareScreen) {
      log('this browser cannot capture a screen — on a PC, open this page in Chrome');
      return;
    }
    const s = new ScreenShareSource(send, (reason) => {
      source = null;
      show('share-btn');
      hide('stop-btn');
      log(`share ended: ${reason}`);
    });
    try {
      await s.start(await fetchIceServers(link.sessionToken));
    } catch (e) {
      const err = e as Error;
      log(`screen capture failed: ${err.message}. On a PC, use Chrome and open http://localhost:${location.port}.`);
      return;
    }
    source = s;
    hide('share-btn');
    show('stop-btn');
  }

  async function onControl(msg: ControlMessage): Promise<void> {
    switch (msg.t) {
      case 'text': {
        const div = document.createElement('div');
        div.className = 'chat peer';
        div.textContent = msg.body;
        $('chat-log').appendChild(div);
        $('chat-log').scrollTop = $('chat-log').scrollHeight;
        return;
      }
      case 'view-request':
        log('the other device wants to see your screen — press "Share my screen"');
        $('share-btn').classList.add('nudge');
        return;
      case 'session-offer':
        if (msg.subsystem === 'remote-view') {
          document.body.classList.add('viewing');
          await sink.handleOffer(msg as SessionOffer, await fetchIceServers(link.sessionToken));
        }
        return;
      case 'session-answer':
        await source?.handle(msg);
        return;
      case 'ice-candidate':
        await source?.handle(msg);
        await sink.handle(msg);
        return;
      case 'session-close':
        await source?.handle(msg);
        await sink.handle(msg);
        return;
    }
  }

  // buttons
  if (canShareScreen) show('share-btn');
  else show('share-unavailable');
  $<HTMLButtonElement>('share-btn').onclick = () => {
    $('share-btn').classList.remove('nudge');
    void startShare();
  };
  $<HTMLButtonElement>('stop-btn').onclick = () => source?.stop('stopped');
  $<HTMLButtonElement>('view-btn').onclick = () => {
    send({ t: 'view-request' });
    log('asked the other device to share its screen…');
  };
  video.onclick = () => void video.play().catch(() => {});

  // text channel
  const chatInput = $<HTMLInputElement>('chat-input');
  const sendText = (): void => {
    const body = chatInput.value.trim();
    if (!body || !link.isPaired) return;
    send({ t: 'text', body });
    const div = document.createElement('div');
    div.className = 'chat mine';
    div.textContent = body;
    $('chat-log').appendChild(div);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    chatInput.value = '';
  };
  $<HTMLButtonElement>('chat-send').onclick = sendText;
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendText();
  });

  // ---- connect + pair ------------------------------------------------------

  setStatus('connecting to broker…');
  try {
    await link.connect();
  } catch {
    setStatus('cannot reach the broker — is the server running?');
    return;
  }

  if (role === 'responder') {
    let lanHost = location.hostname;
    try {
      const info = (await (await fetch('/net-info')).json()) as { lanAddresses: string[] };
      if (info.lanAddresses[0]) lanHost = info.lanAddresses[0];
    } catch {
      /* fall back to current host */
    }
    const blob = toB64Url(
      new TextEncoder().encode(JSON.stringify({ id: link.deviceId, key: btoa(String.fromCharCode(...kp.publicKey)) })),
    );
    const pairUrl = `http://${lanHost}:${location.port || '80'}/#pair=${blob}`;
    renderQr($<HTMLCanvasElement>('qr'), pairUrl);
    $('pair-url').textContent = pairUrl;
    show('pair-panel');
    setStatus('scan this QR with your phone camera to pair');
  } else {
    setStatus(`connecting to ${peerLabel}…`);
  }

  link
    .pair()
    .then(() => {
      document.body.classList.add('paired');
      hide('pair-panel');
      setStatus('connected & verified', true);
      // Remember the peer so next time we skip the QR.
      if (link.peerId && link.peerPublicKey) {
        const known = peerLabel !== 'the host' && peerLabel !== 'peer';
        const label = role === 'initiator' ? (known ? peerLabel : 'My host PC') : 'My device';
        rememberPeer(link.peerId, link.peerPublicKey, label);
      }
      // A client auto-asks to view the host's screen; adjust to taste.
      if (role === 'initiator') send({ t: 'view-request' });
    })
    .catch((e: Error) => setStatus(`pairing failed: ${e.message}`));
}

// ---- boot ------------------------------------------------------------------

const fragment = parsePairFragment();
if (fragment) {
  startInitiator(fragment);
} else {
  show('home');
  renderHome();
}
