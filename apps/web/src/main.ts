/**
 * Web client entry. One page, two roles:
 *
 *   PC (responder):    open http://localhost:8080 — registers, shows a QR whose
 *                      URL carries this device's id+key, waits for the phone,
 *                      then can share its screen.
 *   Phone (initiator): scan the QR with the native camera — Safari opens
 *                      http://<lan-ip>:8080/#pair=<blob>, the page registers,
 *                      handshakes, and can view the PC screen.
 *
 * The #pair fragment is the PC's PUBLIC key + id (same base64 JSON blob as
 * apps/reference-cli/src/pair.ts) — safe in a URL, and a fragment never reaches
 * the server.
 */

import { displayFingerprint, type SessionOffer } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from './identity-store.ts';
import { deviceIdFromPublicKey } from './crypto-noble.ts';
import { SecureLink } from './secure-link.ts';
import { decodeControl, encodeControl, type ControlMessage } from './control.ts';
import { fetchIceServers, ScreenShareSink, ScreenShareSource } from './rtc.ts';
import { renderQr } from './qr.ts';
import { fromB64, fromB64Url, toB64Url } from './b64.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusEl = $('status');
const logEl = $('log');

function setStatus(text: string, ok = false): void {
  statusEl.textContent = text;
  statusEl.className = ok ? 'ok' : '';
}

function log(line: string): void {
  const div = document.createElement('div');
  div.textContent = line;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

interface PairBlob {
  id: string;
  key: string; // base64 raw X25519 public key
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

async function main(): Promise<void> {
  const pair = parsePairFragment();
  const role = pair ? 'initiator' : 'responder';
  document.body.dataset.role = role;

  const kp = loadOrCreateIdentity();
  const myId = deviceIdFromPublicKey(kp.publicKey);
  $('my-fingerprint').textContent = displayFingerprint(myId);
  $('role-badge').textContent = role === 'responder' ? 'PC' : 'phone';

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const link = new SecureLink({
    serverUrl: `${wsProto}://${location.host}/signal`,
    staticKeypair: kp,
    role,
    peerDeviceId: pair?.id,
    peerStatic: pair ? fromB64(pair.key) : undefined,
    log,
    onMessage: (pt) => {
      const msg = decodeControl(pt);
      if (msg) void onControl(msg);
    },
    onPeerStatus: (online) => {
      if (!link.isPaired) setStatus(online ? 'peer online, pairing…' : 'waiting for the PC to come online…');
    },
  });

  const send = (m: ControlMessage): void => link.send(encodeControl(m));

  // ---- screen share wiring --------------------------------------------------

  const video = $<HTMLVideoElement>('remote-video');
  const shareBtn = $<HTMLButtonElement>('share-btn');
  const stopBtn = $<HTMLButtonElement>('stop-btn');
  const viewBtn = $<HTMLButtonElement>('view-btn');

  let source: ScreenShareSource | null = null; // PC
  const sink = new ScreenShareSink(send, video, (reason) => {
    // phone
    document.body.classList.remove('viewing');
    log(`view ended: ${reason}`);
  });

  async function startShare(): Promise<void> {
    if (source) return;
    const s = new ScreenShareSource(send, (reason) => {
      source = null;
      shareBtn.hidden = false;
      stopBtn.hidden = true;
      log(`share ended: ${reason}`);
    });
    try {
      await s.start(await fetchIceServers(link.sessionToken));
    } catch (e) {
      log(`screen capture failed: ${(e as Error).message}`);
      return;
    }
    source = s;
    shareBtn.hidden = true;
    stopBtn.hidden = false;
  }

  async function onControl(msg: ControlMessage): Promise<void> {
    switch (msg.t) {
      case 'text': {
        const div = document.createElement('div');
        div.className = 'chat peer';
        div.textContent = msg.body;
        $('chat-log').appendChild(div);
        return;
      }
      case 'view-request':
        log('peer asks to view this screen — click "Share screen"');
        shareBtn.classList.add('nudge');
        return;
      case 'session-offer':
        if (role === 'initiator' && msg.subsystem === 'remote-view') {
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

  shareBtn.onclick = () => {
    shareBtn.classList.remove('nudge');
    void startShare();
  };
  stopBtn.onclick = () => source?.stop('stopped');
  viewBtn.onclick = () => {
    send({ t: 'view-request' });
    log('asked the PC to share its screen…');
  };
  video.onclick = () => void video.play().catch(() => {}); // Safari tap-to-play fallback

  // ---- text channel ---------------------------------------------------------

  const chatInput = $<HTMLInputElement>('chat-input');
  $('chat-send').onclick = sendText;
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendText();
  });
  function sendText(): void {
    const body = chatInput.value.trim();
    if (!body || !link.isPaired) return;
    send({ t: 'text', body });
    const div = document.createElement('div');
    div.className = 'chat mine';
    div.textContent = body;
    $('chat-log').appendChild(div);
    chatInput.value = '';
  }

  // ---- connect + pair -------------------------------------------------------

  setStatus('connecting to broker…');
  try {
    await link.connect();
  } catch {
    setStatus('cannot reach the broker — is the server running?');
    return;
  }

  if (role === 'responder') {
    // Build the pairing URL the phone will open. The page can't know its own
    // LAN address, so ask the server.
    let lanHost = location.hostname;
    try {
      const info = (await (await fetch('/net-info')).json()) as { lanAddresses: string[] };
      if (info.lanAddresses[0]) lanHost = info.lanAddresses[0];
    } catch {
      // fall back to whatever host the page was opened on
    }
    const blob = toB64Url(
      new TextEncoder().encode(JSON.stringify({ id: link.deviceId, key: btoa(String.fromCharCode(...kp.publicKey)) })),
    );
    const pairUrl = `http://${lanHost}:${location.port || '80'}/#pair=${blob}`;
    renderQr($<HTMLCanvasElement>('qr'), pairUrl);
    $('pair-url').textContent = pairUrl;
    setStatus('scan the QR with your phone camera');
  } else {
    setStatus('pairing with the PC…');
  }

  const pairing = link.pair();
  pairing
    .then(() => {
      document.body.classList.add('paired');
      setStatus('paired & verified', true);
      if (role === 'initiator') send({ t: 'view-request' });
    })
    .catch((e: Error) => setStatus(`pairing failed: ${e.message}`));
}

void main();
