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
 *   - A PC (Chrome) SHARES its screen; a phone SHARES its camera (getUserMedia,
 *     the iPhone path) or, on Android Chrome, its screen (getDisplayMedia).
 *   - Any browser can VIEW the peer's shared media.
 *   - When the sharer can inject OS input (a PC beside the broker, via the
 *     localhost /inject channel), the viewer can CONTROL it: touch/keyboard on
 *     the video drive the PC's mouse and keyboard, gated by the PC's opt-in.
 *   - An encrypted text/clipboard channel runs both ways.
 *
 * Controlling a PHONE is only possible on Android via the native app
 * (AccessibilityService, Phase E); iOS is not controllable at all.
 */

import { displayFingerprint, type DeviceCapabilities, type SessionOffer } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from './identity-store.ts';
import { deviceIdFromPublicKey } from './crypto-noble.ts';
import { SecureLink } from './secure-link.ts';
import { decodeControl, encodeControl, type ControlMessage } from './control.ts';
import { fetchIceServers, MediaShareSink, MediaShareSource, type ShareMode } from './rtc.ts';
import { localCaps, canShareScreen, canShareCamera } from './caps.ts';
import { InjectLink } from './inject-link.ts';
import { IosControlLink } from './ios-control-link.ts';
import { attachViewerInput } from './control-input.ts';
import { renderQr } from './qr.ts';
import { fromB64, fromB64Url, toB64Url } from './b64.ts';
import { listKnownPeers, peerKeyBytes, rememberPeer, type KnownPeer } from './known-peers.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

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

  // ---- injection bridge (PC only): forwards phone control to Win32 SendInput -
  const injectLink = new InjectLink(() => link.sessionToken, log);
  let injectAvailable = false;

  // ---- iOS control (PC only): drives a WDA-equipped iPhone over the LAN ------
  const iosScreen = $<HTMLImageElement>('ios-screen');
  const iosStatus = $('ios-status');
  const iosLink = new IosControlLink(
    () => link.sessionToken,
    (s, msg) => {
      iosStatus.textContent =
        s === 'ready'
          ? 'iPhone connected — tick the box to control it.'
          : s === 'connecting'
            ? 'connecting to WebDriverAgent…'
            : `iPhone unreachable${msg ? `: ${msg}` : ''}`;
    },
    (png) => {
      iosScreen.src = `data:image/png;base64,${png}`;
    },
    log,
    (backend) => {
      // The HID (pymobiledevice3) backend needs no WDA URL — hide the field.
      if (backend === 'hid') {
        hide('ios-wda-url');
        iosStatus.textContent = 'Connecting over the developer tunnel (no app needed on the iPhone)…';
      }
    },
  );

  // ---- peer capability exchange (rides inside the Noise transport) ---------
  let peerCaps: DeviceCapabilities | null = null;

  // ---- media wiring (symmetric: this page can share AND view) --------------

  const video = $<HTMLVideoElement>('remote-video');
  const wrap = $('video-wrap');
  const keyboardInput = $<HTMLInputElement>('control-keyboard');
  let source: MediaShareSource | null = null;
  let controlActive = false;

  const exitFullscreen = (): void => {
    document.body.classList.remove('fullscreen');
    hide('viewer-toolbar');
  };

  const sink = new MediaShareSink(
    send,
    video,
    (reason) => {
      document.body.classList.remove('viewing');
      hide('fullscreen-btn');
      exitFullscreen();
      viewer.resetZoom();
      log(`view ended: ${reason}`);
    },
    (open) => {
      // The control channel exists only when the sharer offered control, so its
      // opening means the peer is controllable. Toggle the control affordances.
      controlActive = open;
      document.body.classList.toggle('controlling', open);
      if (open) {
        show('control-active');
        const android = peerCaps?.platform === 'android';
        for (const id of ['nav-back', 'nav-home', 'nav-recents', 'fs-back', 'fs-home', 'fs-recents']) {
          $(id).hidden = !android;
        }
        $('control-note').textContent =
          'Control is live: one finger moves the pointer and taps; pinch to zoom, two fingers to scroll. Use "Keyboard" to type.';
      } else {
        hide('control-active');
      }
    },
  );

  // Viewer input (zoom/pan always; control events only when the channel is live).
  const viewer = attachViewerInput(wrap, video, keyboardInput, {
    send: (ev) => sink.sendInput(ev),
    canControl: () => controlActive,
  });

  async function startShare(mode: ShareMode): Promise<void> {
    if (source) return;
    const s = new MediaShareSource(send, (reason) => {
      source = null;
      updateShareButtons();
      hide('stop-btn');
      log(`share ended: ${reason}`);
    });
    try {
      await s.start(await fetchIceServers(link.sessionToken), {
        mode,
        direction: role === 'responder' ? 'pc-to-phone' : 'phone-to-pc',
        offerControl: injectAvailable,
        onInput: (ev) => injectLink.send(ev),
      });
    } catch (e) {
      const err = e as Error;
      log(`${mode} capture failed: ${err.message}`);
      return;
    }
    source = s;
    hide('share-btn');
    hide('share-camera-btn');
    show('stop-btn');
  }

  async function onControl(msg: ControlMessage): Promise<void> {
    switch (msg.t) {
      case 'peer-caps':
        peerCaps = msg.device;
        log(`peer is a ${msg.device.platform} device (${msg.device.remoteControl.controllableVia === 'none' ? 'view-only' : 'controllable'})`);
        return;
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
        if (msg.subsystem === 'remote-view' || msg.subsystem === 'remote-control') {
          document.body.classList.add('viewing');
          show('fullscreen-btn');
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

  // ---- share/view/control buttons ------------------------------------------

  function updateShareButtons(): void {
    if (source) return;
    if (canShareScreen()) show('share-btn');
    if (canShareCamera()) show('share-camera-btn');
    if (!canShareScreen() && !canShareCamera()) show('share-unavailable');
  }
  updateShareButtons();

  $<HTMLButtonElement>('share-btn').onclick = () => {
    $('share-btn').classList.remove('nudge');
    void startShare('screen');
  };
  $<HTMLButtonElement>('share-camera-btn').onclick = () => void startShare('camera');
  $<HTMLButtonElement>('stop-btn').onclick = () => source?.stop('stopped');
  $<HTMLButtonElement>('view-btn').onclick = () => {
    send({ t: 'view-request' });
    log('asked the other device to share its screen…');
  };
  video.onclick = () => void video.play().catch(() => {});

  // PC opt-in to being controlled.
  const allowControl = $<HTMLInputElement>('allow-control');
  allowControl.onchange = () => {
    injectLink.setEnabled(allowControl.checked);
    $('control-note').textContent = allowControl.checked
      ? 'This PC can now be controlled by the paired device while it is viewing your screen.'
      : 'Control is off. Tick the box to let the paired device drive this PC.';
  };

  // iOS control affordances (PC side): connect to WDA, opt in, drive.
  const iosWdaUrl = $<HTMLInputElement>('ios-wda-url');
  const iosAllow = $<HTMLInputElement>('ios-allow');
  const iosKeyboard = $<HTMLInputElement>('ios-keyboard');
  $<HTMLButtonElement>('ios-connect').onclick = () => {
    iosStatus.textContent = 'connecting…';
    void iosLink.connect(iosWdaUrl.value.trim());
  };
  iosAllow.onchange = () => {
    iosLink.setEnabled(iosAllow.checked);
    if (iosAllow.checked) iosKeyboard.focus();
  };

  // Phone control affordances.
  $<HTMLButtonElement>('keyboard-btn').onclick = () => keyboardInput.focus();
  $<HTMLButtonElement>('nav-back').onclick = () => sink.sendInput({ i: 'nav', action: 'back' });
  $<HTMLButtonElement>('nav-home').onclick = () => sink.sendInput({ i: 'nav', action: 'home' });
  $<HTMLButtonElement>('nav-recents').onclick = () => sink.sendInput({ i: 'nav', action: 'recents' });

  // Fullscreen + zoom + fullscreen toolbar (viewer side).
  $<HTMLButtonElement>('fullscreen-btn').onclick = () => {
    document.body.classList.add('fullscreen');
    show('viewer-toolbar');
  };
  $<HTMLButtonElement>('fs-exit').onclick = () => {
    exitFullscreen();
    viewer.resetZoom();
  };
  $<HTMLButtonElement>('fs-reset').onclick = () => viewer.resetZoom();
  $<HTMLButtonElement>('fs-keyboard').onclick = () => keyboardInput.focus();
  $<HTMLButtonElement>('fs-back').onclick = () => sink.sendInput({ i: 'nav', action: 'back' });
  $<HTMLButtonElement>('fs-home').onclick = () => sink.sendInput({ i: 'nav', action: 'home' });
  $<HTMLButtonElement>('fs-recents').onclick = () => sink.sendInput({ i: 'nav', action: 'recents' });

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

  // Probe the localhost injection channel — succeeds only on the PC beside the
  // broker. Its result decides whether we advertise ourselves as controllable.
  injectAvailable = await injectLink.probe();
  if (injectAvailable) show('allow-control-row');

  // Same idea for iOS control: the /ios-control channel only connects on the PC
  // beside the server. Reveal the panel and wire input capture when it does.
  if (await iosLink.connect(iosWdaUrl.value.trim())) {
    show('ios-panel');
    iosLink.attachInput(iosScreen, iosKeyboard);
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
      // Advertise what this device can do (rides inside the Noise transport).
      send({ t: 'peer-caps', device: localCaps(injectAvailable) });
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
