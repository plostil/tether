/**
 * WebRTC screen-view session (SPEC §2.1 remote-view, docs/MEDIA.md).
 *
 * SDP and ICE ride INSIDE the Noise transport as the shared SessionOffer /
 * SessionAnswer / IceCandidateMsg / SessionClose messages — the broker never
 * sees them. On a home LAN the media path is P2P host-to-host; STUN/TURN from
 * GET /ice (Bearer sessionToken) is the fallback.
 *
 * The source's stream comes from a MediaStreamProvider so the SAME WebRTC path
 * serves a real screen (getDisplayMedia), the demo's synthetic canvas, and the
 * iPhone bridge's MJPEG-into-canvas — only the provider differs. Connection
 * state and live stats are surfaced so the UI can show quality and faults.
 */

import type {
  DeviceCapabilities,
  IceCandidateMsg,
  SessionAnswer,
  SessionClose,
  SessionOffer,
} from '@tether/protocol/browser';
import { negotiateSession, type SubsystemKind } from '@tether/protocol/browser';
import type { ControlMessage } from './control.ts';

interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Supplies the MediaStream a source will send. */
export type MediaStreamProvider = () => Promise<MediaStream>;

export interface CaptureFault {
  kind: 'not-allowed' | 'not-supported' | 'insecure-context' | 'not-found' | 'unknown';
  message: string;
}

/** getDisplayMedia wrapped so its failure modes become typed, explained faults. */
export function displayMediaProvider(): MediaStreamProvider {
  return async () => {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
      const fault: CaptureFault = !isSecureContext
        ? {
            kind: 'insecure-context',
            message:
              'Screen capture needs a secure context. Open this page via http://localhost:8080 on the PC, not the LAN address.',
          }
        : {
            kind: 'not-supported',
            message: 'This browser cannot capture a screen. On a PC, use Chrome or Edge.',
          };
      throw fault;
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (e) {
      const err = e as DOMException;
      const map: Record<string, CaptureFault> = {
        NotAllowedError: { kind: 'not-allowed', message: 'You cancelled the screen-share picker.' },
        NotFoundError: { kind: 'not-found', message: 'No screen or window was available to share.' },
      };
      throw map[err.name] ?? { kind: 'unknown', message: err.message || 'Screen capture failed.' };
    }
  };
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

function watchConnection(pc: RTCPeerConnection, onState: (s: RTCPeerConnectionState) => void, onDrop: () => void): void {
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  pc.onconnectionstatechange = () => {
    onState(pc.connectionState);
    if (pc.connectionState === 'failed') {
      onDrop();
    } else if (pc.connectionState === 'disconnected') {
      graceTimer = setTimeout(() => {
        if (pc.connectionState === 'disconnected') onDrop();
      }, 5000);
    } else if (pc.connectionState === 'connected' && graceTimer) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
}

// ---- live stats -------------------------------------------------------------

export interface RtcStats {
  rttMs: number | null;
  kbps: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  candidateType: string | null; // host | srflx | relay | prflx
  dtlsState: string | null;
}

/** Samples getStats() once per second and reports a flat, UI-ready snapshot. */
export class RtcStatsSampler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastBytes = 0;
  private lastTs = 0;

  constructor(
    private readonly pc: RTCPeerConnection,
    private readonly onSample: (s: RtcStats) => void,
    private readonly kind: 'inbound' | 'outbound' = 'inbound',
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.sample(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sample(): Promise<void> {
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return;
    }
    const out: RtcStats = {
      rttMs: null,
      kbps: null,
      fps: null,
      width: null,
      height: null,
      candidateType: null,
      dtlsState: null,
    };
    const type = this.kind === 'inbound' ? 'inbound-rtp' : 'outbound-rtp';
    const candTypes: Record<string, string> = {};
    report.forEach((s: any) => {
      if (s.type === type && s.kind === 'video') {
        out.fps = s.framesPerSecond ?? null;
        out.width = s.frameWidth ?? null;
        out.height = s.frameHeight ?? null;
        const bytes = (this.kind === 'inbound' ? s.bytesReceived : s.bytesSent) ?? 0;
        const now = s.timestamp ?? performance.now();
        if (this.lastTs && now > this.lastTs) {
          out.kbps = Math.round(((bytes - this.lastBytes) * 8) / (now - this.lastTs));
        }
        this.lastBytes = bytes;
        this.lastTs = now;
      } else if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        if (typeof s.currentRoundTripTime === 'number') out.rttMs = Math.round(s.currentRoundTripTime * 1000);
      } else if (s.type === 'local-candidate' || s.type === 'remote-candidate') {
        candTypes[s.id] = s.candidateType;
      } else if (s.type === 'transport') {
        out.dtlsState = s.dtlsState ?? null;
      }
    });
    // Resolve the nominated pair's local candidate type.
    report.forEach((s: any) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        out.candidateType = candTypes[s.localCandidateId] ?? out.candidateType;
      }
    });
    this.onSample(out);
  }
}

// ---- source (captures + sends) ----------------------------------------------

/** Source side: captures a stream from a provider and streams it to the peer. */
export class ScreenShareSource {
  readonly sessionId = crypto.randomUUID();
  pc: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private answered = false;
  private pendingCandidates: IceCandidateMsg[] = [];

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly onEnded: (reason: string) => void,
    private readonly subsystem: SubsystemKind = 'remote-view',
  ) {}

  async start(iceServers: IceServer[], provider: MediaStreamProvider): Promise<void> {
    this.stream = await provider(); // may throw a CaptureFault — caller surfaces it
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    for (const track of this.stream.getTracks()) {
      pc.addTrack(track, this.stream);
      // The browser's own "stop sharing" bar ends the track outside our UI.
      track.onended = () => this.stop('capture ended');
    }
    wireCandidate(this.sessionId, pc, this.send);
    watchConnection(pc, () => {}, () => this.stop('connection lost', false));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.send({
      t: 'session-offer',
      sessionId: this.sessionId,
      subsystem: this.subsystem,
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

// ---- sink (receives + renders) ----------------------------------------------

export interface SinkGate {
  localCaps: DeviceCapabilities;
  peerCaps: DeviceCapabilities | null;
  localId: string;
  peerId: string;
}

/** Sink side: accepts an offer (after a capability gate) and renders the track. */
export class ScreenShareSink {
  pc: RTCPeerConnection | null = null;
  private sessionId: string | null = null;

  constructor(
    private readonly send: (m: ControlMessage) => void,
    private readonly onStream: (stream: MediaStream) => void,
    private readonly onEnded: (reason: string) => void,
    private readonly onRejected?: (reason: string) => void,
  ) {}

  get active(): boolean {
    return this.pc !== null;
  }

  async handleOffer(offer: SessionOffer, iceServers: IceServer[], gate: SinkGate): Promise<void> {
    // Enforce the SPEC §2 feasibility gate before answering (was dead code before).
    const peerCaps: DeviceCapabilities = gate.peerCaps ?? {
      ...gate.localCaps,
      remoteView: { canBeViewed: true, canView: true, unattended: false },
    };
    const result = negotiateSession(
      { kind: offer.subsystem, source: gate.peerId, sink: gate.localId },
      peerCaps,
      gate.localCaps,
    );
    if (!result.ok) {
      this.send({ t: 'session-answer', sessionId: offer.sessionId, accepted: false, reason: result.reason });
      this.onRejected?.(result.reason);
      return;
    }

    if (this.pc) this.stop('superseded by new offer', false);
    this.sessionId = offer.sessionId;
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    pc.ontrack = (e) => this.onStream(e.streams[0] ?? new MediaStream([e.track]));
    wireCandidate(offer.sessionId, pc, this.send);
    watchConnection(pc, () => {}, () => this.stop('connection lost', false));
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
    this.onEnded(reason);
  }
}
