/**
 * WebRTC media session (SPEC §2.1 remote-view / remote-control, docs/MEDIA.md).
 *
 * SDP and ICE ride INSIDE the Noise transport as the shared SessionOffer /
 * SessionAnswer / IceCandidateMsg / SessionClose messages — the broker never
 * sees them. On a home LAN the media path is P2P host-to-host; STUN/TURN from
 * GET /ice (Bearer sessionToken) is the fallback.
 *
 * Symmetric by design: either side can be the SOURCE (share a screen with
 * getDisplayMedia, or a camera with getUserMedia — the iPhone path) and either
 * the SINK (render the remote track). When the source can also be controlled
 * (its OS injection path is available), it opens an `input` DataChannel BEFORE
 * the offer — unreliable + unordered per SPEC §4, so a lost pointer sample
 * cannot head-of-line block the cursor — and the sink drives it. Whether events
 * are acted on is gated live by the controlled side's opt-in, so no
 * renegotiation is ever needed to start or stop control.
 */

import type {
  IceCandidateMsg,
  InputEvent,
  MediaDirection,
  MediaKind,
  SessionAnswer,
  SessionClose,
  SessionOffer,
} from '@tether/protocol/browser';
import { decodeInputEvent, encodeInputEvent } from '@tether/protocol/browser';
import type { ControlMessage } from './control.ts';

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** ICE servers from the broker; empty list (host candidates only) on failure. */
export async function fetchIceServers(sessionToken: string | null): Promise<IceServer[]> {
  if (!sessionToken) return [];
  try {
    const res = await fetch('/ice', { headers: { authorization: `Bearer ${sessionToken}` } });
    if (!res.ok) return [];
    const cfg = (await res.json()) as { iceServers?: IceServer[] };
    return cfg.iceServers ?? [];
  } catch {
    return [];
  }
}

function wireCandidate(sessionId: string, pc: RTCPeerConnection, send: (m: ControlMessage) => void): void {
  pc.onicecandidate = (e) => {
    if (!e.candidate) return; // end-of-candidates needs no message
    send({
      t: 'ice-candidate',
      sessionId,
      candidate: JSON.stringify({
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      }),
    });
  };
}

async function addCandidate(pc: RTCPeerConnection, msg: IceCandidateMsg): Promise<void> {
  try {
    await pc.addIceCandidate(JSON.parse(msg.candidate) as RTCIceCandidateInit);
  } catch {
    // a malformed/late candidate is not fatal — ICE continues with the rest
  }
}

export type ShareMode = 'screen' | 'camera';

export interface ShareOptions {
  mode: ShareMode;
  direction: MediaDirection;
  /** Open an `input` DataChannel and accept control (only when this device can inject). */
  offerControl: boolean;
  /** Control events arriving from the sink; injected by the caller. */
  onInput?: (ev: InputEvent) => void;
}

async function captureStream(mode: ShareMode): Promise<MediaStream> {
  if (mode === 'camera') {
    return navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  }
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
}

/** Source side: captures a screen or camera and streams it to the peer. */
export class MediaShareSource {
  readonly sessionId = crypto.randomUUID();
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private answered = false;
  private pendingCandidates: IceCandidateMsg[] = [];

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly onEnded: (reason: string) => void,
  ) {}

  async start(iceServers: IceServer[], opts: ShareOptions): Promise<void> {
    this.stream = await captureStream(opts.mode);
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;

    if (opts.offerControl) {
      // Created BEFORE the offer so it is part of the initial SDP — control
      // never triggers renegotiation. Unreliable + unordered (SPEC §4).
      const ch = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
      this.channel = ch;
      ch.onmessage = (e) => {
        const ev = decodeInputEvent(typeof e.data === 'string' ? e.data : '');
        if (ev && opts.onInput) opts.onInput(ev);
      };
    }

    for (const track of this.stream.getTracks()) {
      pc.addTrack(track, this.stream);
      // The browser's own "stop sharing" bar ends the track outside our UI.
      track.onended = () => this.stop('capture ended');
    }
    wireCandidate(this.sessionId, pc, this.send);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const kind: MediaKind = opts.mode === 'camera' ? 'camera-video' : 'screen-video';
    this.send({
      t: 'session-offer',
      sessionId: this.sessionId,
      subsystem: opts.offerControl ? 'remote-control' : 'remote-view',
      tracks: [{ kind, direction: opts.direction }],
      sdp: offer.sdp!,
      control: opts.offerControl,
    });
  }

  async handle(msg: SessionAnswer | IceCandidateMsg | SessionClose): Promise<void> {
    if (msg.sessionId !== this.sessionId || !this.pc) return;
    switch (msg.t) {
      case 'session-answer': {
        if (!msg.accepted || !msg.sdp) {
          this.stop(`peer declined: ${msg.reason ?? 'no reason'}`, false);
          return;
        }
        await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        this.answered = true;
        for (const c of this.pendingCandidates.splice(0)) await addCandidate(this.pc, c);
        return;
      }
      case 'ice-candidate':
        if (!this.answered) this.pendingCandidates.push(msg);
        else await addCandidate(this.pc, msg);
        return;
      case 'session-close':
        this.stop(msg.reason ?? 'closed by peer', false);
        return;
    }
  }

  stop(reason: string, notifyPeer = true): void {
    if (!this.pc) return;
    if (notifyPeer) this.send({ t: 'session-close', sessionId: this.sessionId, reason });
    this.channel?.close();
    this.channel = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.pc = null;
    this.onEnded(reason);
  }
}

/** Sink side: renders the peer's media track and drives its `input` channel. */
export class MediaShareSink {
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;
  private channel: RTCDataChannel | null = null;

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly video: HTMLVideoElement,
    private readonly onEnded: (reason: string) => void,
    /** Fired when the control channel opens/closes so the UI can enable input capture. */
    private readonly onControlReady: (open: boolean) => void = () => {},
  ) {}

  get active(): boolean {
    return this.pc !== null;
  }

  get controlOpen(): boolean {
    return this.channel?.readyState === 'open';
  }

  /** Send a control event to the source. Dropped when the channel isn't open (unreliable semantics). */
  sendInput(ev: InputEvent): void {
    if (this.channel?.readyState === 'open') this.channel.send(encodeInputEvent(ev));
  }

  async handleOffer(offer: SessionOffer, iceServers: IceServer[]): Promise<void> {
    if (this.pc) this.stop('superseded by new offer', false);
    this.sessionId = offer.sessionId;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.ontrack = (e) => {
      this.video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      // Safari: muted + playsinline are set on the element; play() from here
      // usually succeeds because the session started from a user tap.
      void this.video.play().catch(() => {});
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      this.channel = ch;
      ch.onopen = () => this.onControlReady(true);
      ch.onclose = () => this.onControlReady(false);
    };
    wireCandidate(offer.sessionId, pc, this.send);
    await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ t: 'session-answer', sessionId: offer.sessionId, accepted: true, sdp: answer.sdp! });
  }

  async handle(msg: IceCandidateMsg | SessionClose): Promise<void> {
    if (msg.sessionId !== this.sessionId || !this.pc) return;
    if (msg.t === 'ice-candidate') {
      await addCandidate(this.pc, msg);
      return;
    }
    this.stop(msg.reason ?? 'closed by peer', false);
  }

  stop(reason: string, notifyPeer = true): void {
    if (!this.pc) return;
    if (notifyPeer && this.sessionId) {
      this.send({ t: 'session-close', sessionId: this.sessionId, reason });
    }
    this.channel?.close();
    this.channel = null;
    this.pc.close();
    this.pc = null;
    this.sessionId = null;
    this.video.srcObject = null;
    this.onControlReady(false);
    this.onEnded(reason);
  }
}
