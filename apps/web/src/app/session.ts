/**
 * SessionController — owns the ONE active link and its media, independent of
 * which screen is mounted, so navigating between Live, Devices, and Settings
 * never drops the connection. It wraps SecureLink (over the shared page
 * BrokerClient), the WebRTC source/sink, the stats sampler, and control-message
 * dispatch, and reflects everything into the store for screens to render.
 */

import type { DeviceCapabilities } from '@tether/protocol/browser';
import type { IBrokerClient } from '../broker-client.ts';
import type { StaticKeypair } from '@tether/protocol/browser';
import { SecureLink, type LinkEvent, type LinkState } from '../secure-link.ts';
import {
  ScreenShareSink,
  ScreenShareSource,
  RtcStatsSampler,
  displayMediaProvider,
  fetchIceServers,
  type RtcStats,
  type CaptureFault,
  type MediaStreamProvider,
} from '../rtc.ts';
import { decodeControl, encodeControl, type ControlMessage, type InputEvent } from '../control.ts';
import { browserCapabilities, type Mode } from '../capabilities.ts';
import { rememberPeer, type VerifiedBy } from '../known-peers.ts';
import type { PairBlob } from '../pairing.ts';
import type { Store } from './store.ts';
import type { AppState } from './state.ts';

export interface StartOpts {
  role: 'initiator' | 'responder';
  peer?: PairBlob;
  mode: Mode;
  label?: string;
  verifiedBy?: VerifiedBy;
  demo?: boolean;
  /** Demo only: the virtual device's stream, shown directly when the network
   *  blocks even the in-tab WebRTC connection (see watchForStall). */
  localFallback?: () => MediaStream;
}

/** How long a negotiated stream may sit without a network path before the UI
 *  says so. On a working LAN, ICE connects in well under a second. */
const STALL_MS = 10_000;
/** The demo's two ends share a tab, so it gives up on WebRTC sooner. */
const DEMO_STALL_MS = 4_000;

export class SessionController {
  /** Stable video element, owned here so the stream survives screen changes. */
  readonly videoEl: HTMLVideoElement;
  private link: SecureLink | null = null;
  private source: ScreenShareSource | null = null;
  private sink: ScreenShareSink | null = null;
  private sampler: RtcStatsSampler | null = null;
  private peerCaps: DeviceCapabilities | null = null;
  private caps: DeviceCapabilities = browserCapabilities(null);
  private opts: StartOpts | null = null;
  /** iPhone mode: what to share (the MJPEG-canvas) and where to forward input
   *  (the local bridge), so a paired device can view and control the phone
   *  through this PC. Null → normal screen share + "cannot be controlled". */
  private screenProvider: MediaStreamProvider | null = null;
  private inputForwarder: ((e: InputEvent) => void) | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackStream: MediaStream | null = null;

  /** iPhone-live registers these once its bridge stream is up. */
  setScreenProvider(p: MediaStreamProvider | null): void {
    this.screenProvider = p;
  }
  setInputForwarder(fn: ((e: InputEvent) => void) | null): void {
    this.inputForwarder = fn;
  }

  constructor(
    private readonly client: IBrokerClient,
    private readonly identity: StaticKeypair,
    private readonly store: Store<AppState>,
    private readonly myName: () => string,
  ) {
    this.videoEl = document.createElement('video');
    this.videoEl.autoplay = true;
    this.videoEl.muted = true;
    this.videoEl.playsInline = true;
    this.videoEl.setAttribute('data-testid', 'remote-video');
    // "Has video" means a decoded frame. The track itself arrives with the SDP
    // answer, even when no packet ever gets through.
    this.videoEl.addEventListener('loadeddata', () => {
      if (this.videoEl.srcObject) this.store.set((s) => ({ session: { ...s.session, hasVideo: true } }));
    });
  }

  get active(): boolean {
    return this.link !== null;
  }

  start(opts: StartOpts): void {
    this.end(false);
    this.opts = opts;
    this.caps = browserCapabilities(opts.mode);
    this.peerCaps = null;
    this.store.set({
      mode: opts.mode,
      link: { state: 'idle', fault: null, steps: {}, peer: opts.peer ? { id: opts.peer.id, name: opts.label ?? null, caps: null } : null, sessionFingerprint: null },
      session: { kind: opts.mode, rtcState: null, dtlsState: null, stats: null, hasVideo: false, path: null, stalled: false, fault: null, refused: null },
    });

    this.sink = new ScreenShareSink(
      (m) => this.relay(m),
      (stream) => {
        this.videoEl.srcObject = stream;
        void this.videoEl.play().catch(() => {});
        this.store.set((s) => ({ session: { ...s.session, path: 'webrtc' } }));
        this.startSampler(this.sink!.pc!, 'inbound');
        this.watchForStall();
      },
      (reason) => {
        this.clearStall();
        this.store.set((s) => ({
          session: {
            ...s.session,
            hasVideo: false,
            stalled: false,
            fault: reason === 'connection lost' ? 'The screen stream dropped: the network path between the devices was lost.' : s.session.fault,
          },
        }));
      },
      (reason) => this.store.set((s) => ({ session: { ...s.session, refused: reason } })),
      (state) => {
        if (state !== 'connected') return;
        this.clearStall();
        this.store.set((s) => ({ session: { ...s.session, stalled: false } }));
      },
    );

    const link = new SecureLink(this.client, this.identity, {
      role: opts.role,
      peerStatic: opts.peer ? peerKey(opts.peer) : undefined,
      peerDeviceId: opts.peer?.id,
      onEvent: (e) => this.onLinkEvent(e),
    });
    this.link = link;
    void link.pair();
  }

  private relay(m: ControlMessage): void {
    try {
      this.link?.send(encodeControl(m));
    } catch {
      /* not paired */
    }
  }

  private onLinkEvent(e: LinkEvent): void {
    if (e.t === 'handshake') {
      this.store.set((s) => ({ link: { ...s.link, steps: { ...s.link.steps, [e.step]: e.status } } }));
      return;
    }
    if (e.t === 'message') {
      void this.onControl(decodeControl(e.plaintext));
      return;
    }
    if (e.t === 'state') {
      this.store.set((s) => ({
        link: {
          ...s.link,
          state: e.state as LinkState,
          fault: e.fault ?? null,
          sessionFingerprint: this.link?.sessionFingerprint ?? s.link.sessionFingerprint,
          peer: s.link.peer ? { ...s.link.peer, id: this.link?.peerId ?? s.link.peer.id } : s.link.peer,
        },
      }));
      if (e.state === 'paired') this.onPaired();
      if (e.state === 'degraded') this.teardownMedia();
    }
  }

  private onPaired(): void {
    const link = this.link!;
    this.relay({ t: 'hello', name: this.myName(), capabilities: this.caps, app: 'web' });
    if (link.peerPublicKey && link.peerId) {
      rememberPeer(link.peerId, link.peerPublicKey, this.opts?.label ?? 'Paired device', {
        verifiedBy: this.opts?.verifiedBy ?? 'qr',
        demo: this.opts?.demo,
      });
    }
    const mode = this.opts?.mode;
    if (mode === 'view' || mode === 'control') {
      this.relay({ t: 'view-request', mode: mode === 'control' ? 'control' : 'view' });
    } else if (mode === 'share') {
      void this.shareScreen(); // proactively share on this side
    }
  }

  private async onControl(msg: ControlMessage | null): Promise<void> {
    if (!msg) return;
    switch (msg.t) {
      case 'hello':
        this.peerCaps = msg.capabilities;
        this.store.set((s) => ({ link: { ...s.link, peer: s.link.peer ? { ...s.link.peer, name: msg.name, caps: msg.capabilities } : { id: this.link?.peerId ?? '', name: msg.name, caps: msg.capabilities } } }));
        return;
      case 'view-request':
        // The peer wants to see our screen. In iPhone mode that is the bridge's
        // MJPEG-canvas (screenProvider); otherwise real getDisplayMedia.
        void this.shareScreen(this.screenProvider ?? undefined);
        return;
      case 'session-offer':
        await this.sink?.handleOffer(msg, await fetchIceServers(this.link?.sessionToken ?? null), {
          localCaps: this.caps,
          peerCaps: this.peerCaps,
          localId: this.client.deviceId,
          peerId: this.link?.peerId ?? '',
        });
        return;
      case 'session-answer':
        await this.source?.handle(msg);
        return;
      case 'ice-candidate':
        await this.source?.handle(msg);
        await this.sink?.handle(msg);
        return;
      case 'session-close':
        await this.source?.handle(msg);
        await this.sink?.handle(msg);
        return;
      case 'input':
        // In iPhone mode, forward the peer's input to the local bridge (it
        // controls the phone). Otherwise a browser page cannot inject OS input.
        if (this.inputForwarder) this.inputForwarder(msg);
        else this.relay({ t: 'input-unsupported', reason: 'This device cannot be controlled from a browser.' });
        return;
      case 'input-unsupported':
        this.store.set((s) => ({ session: { ...s.session, refused: msg.reason } }));
        return;
    }
  }

  /** Capture this screen (real getDisplayMedia) and stream it to the peer. */
  async shareScreen(provider: MediaStreamProvider = displayMediaProvider()): Promise<void> {
    if (this.source) return;
    const src = new ScreenShareSource(
      (m) => this.relay(m),
      () => {
        this.source = null;
        this.store.set((s) => ({ session: { ...s.session, kind: s.session.kind } }));
      },
    );
    try {
      await src.start(await fetchIceServers(this.link?.sessionToken ?? null), provider);
    } catch (e) {
      const fault = e as CaptureFault;
      this.store.set((s) => ({ session: { ...s.session, fault: fault.message ?? 'Screen capture failed.' } }));
      return;
    }
    this.source = src;
    this.startSampler(src.pc!, 'outbound');
  }

  private startSampler(pc: RTCPeerConnection, kind: 'inbound' | 'outbound'): void {
    this.sampler?.stop();
    this.sampler = new RtcStatsSampler(
      pc,
      (stats: RtcStats) => {
        this.store.set((s) => ({
          session: { ...s.session, stats, rtcState: pc.connectionState, dtlsState: stats.dtlsState },
        }));
      },
      kind,
    );
    this.sampler.start();
  }

  /**
   * Start the clock once the stream is negotiated. If ICE hasn't connected by
   * then, tell the user why the video is blank. In the demo, show the virtual
   * device's stream directly instead: both ends live in this tab, yet some
   * networks still block the connection. On campus and office Wi-Fi, for
   * example, Chrome's mDNS host candidates don't resolve, and the NAT won't
   * hairpin the server-reflexive ones.
   */
  private watchForStall(): void {
    this.clearStall();
    const fallback = this.opts?.localFallback;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const pc = this.sink?.pc;
      if (pc?.connectionState === 'connected') return;
      if (fallback) this.useInTabStream(fallback());
      else if (pc) this.store.set((s) => ({ session: { ...s.session, stalled: true } }));
    }, fallback ? DEMO_STALL_MS : STALL_MS);
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  /** Demo fallback: drop the stuck WebRTC session and play the stream in-tab. */
  private useInTabStream(stream: MediaStream): void {
    this.sampler?.stop();
    this.sampler = null;
    this.sink?.stop('no network path; the demo shows the stream in-tab');
    this.fallbackStream = stream;
    this.videoEl.srcObject = stream;
    void this.videoEl.play().catch(() => {});
    const { width = null, height = null, frameRate = null } = stream.getVideoTracks()[0]?.getSettings() ?? {};
    this.store.set((s) => ({
      session: {
        ...s.session,
        path: 'in-tab',
        stalled: false,
        fault: null,
        rtcState: null,
        dtlsState: null,
        stats: { rttMs: null, kbps: null, fps: frameRate, width, height, candidateType: 'in-tab', dtlsState: null },
      },
    }));
  }

  sendText(body: string): void {
    this.relay({ t: 'text', body });
  }

  sendInput(evt: Omit<InputEvent, 't'>): void {
    this.relay({ t: 'input', ...evt });
  }

  retry(): void {
    this.link?.retry();
  }

  private teardownMedia(): void {
    this.clearStall();
    this.fallbackStream?.getTracks().forEach((t) => t.stop());
    this.fallbackStream = null;
    this.sampler?.stop();
    this.sampler = null;
    this.source?.stop('link degraded', false);
    this.source = null;
    this.sink?.stop('link degraded', false);
    this.videoEl.srcObject = null;
  }

  end(notify = true): void {
    if (notify) this.source?.stop('ended by user');
    this.teardownMedia();
    this.link?.close();
    this.link = null;
    this.opts = null;
    this.screenProvider = null;
    this.inputForwarder = null;
    this.store.set({ mode: null, session: { kind: null, rtcState: null, dtlsState: null, stats: null, hasVideo: false, path: null, stalled: false, fault: null, refused: null } });
  }
}

function peerKey(peer: PairBlob): Uint8Array {
  const bin = atob(peer.key);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
