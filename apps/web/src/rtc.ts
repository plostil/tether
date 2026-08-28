/**
 * WebRTC screen-view session (SPEC §2.1 remote-view, docs/MEDIA.md).
 *
 * SDP and ICE ride INSIDE the Noise transport as the shared SessionOffer /
 * SessionAnswer / IceCandidateMsg / SessionClose messages — the broker never
 * sees them. On a home LAN the media path is P2P host-to-host; STUN/TURN from
 * GET /ice (Bearer sessionToken) is the fallback.
 *
 * PC = source (getDisplayMedia needs a user gesture + secure context, which
 * http://localhost provides). Phone = sink (rendering a remote track works on
 * a plain http page).
 */

import type { IceCandidateMsg, SessionAnswer, SessionClose, SessionOffer } from '@tether/protocol/browser';
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

/** PC side: captures the screen and streams it to the phone. */
export class ScreenShareSource {
  readonly sessionId = crypto.randomUUID();
  private pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private answered = false;
  private pendingCandidates: IceCandidateMsg[] = [];

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly onEnded: (reason: string) => void,
  ) {}

  async start(iceServers: IceServer[]): Promise<void> {
    this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of this.stream.getTracks()) {
      pc.addTrack(track, this.stream);
      // The browser's own "stop sharing" bar ends the track outside our UI.
      track.onended = () => this.stop('capture ended');
    }
    wireCandidate(this.sessionId, pc, this.send);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({
      t: 'session-offer',
      sessionId: this.sessionId,
      subsystem: 'remote-view',
      tracks: [{ kind: 'screen-video', direction: 'pc-to-phone' }],
      sdp: offer.sdp!,
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc.close();
    this.pc = null;
    this.onEnded(reason);
  }
}

/** Phone side: renders the PC's screen track into a <video>. */
export class ScreenShareSink {
  private pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly video: HTMLVideoElement,
    private readonly onEnded: (reason: string) => void,
  ) {}

  get active(): boolean {
    return this.pc !== null;
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
    this.pc.close();
    this.pc = null;
    this.sessionId = null;
    this.video.srcObject = null;
    this.onEnded(reason);
  }
}
