/**
 * Media/session layer (SPEC §2 subsystems, §4 codecs).
 *
 * Once two devices are paired (Noise transport up), a *session* carries the
 * actual media: screen video, app/mic audio, or a call. The control messages
 * below ride INSIDE the Noise-encrypted transport (SecureLink.send) — never the
 * broker relay — and carry WebRTC's own SDP/ICE so the media path goes P2P.
 *
 * `negotiateVideo` is the testable heart: it applies the spec's per-direction
 * codec policy so an unsupported combination is rejected at negotiation time.
 * The WebRTC wiring itself lives in the native clients (see docs/MEDIA.md).
 */

import type { Platform } from './capabilities.ts';
import type { SubsystemKind } from './session.ts';

export type MediaDirection = 'pc-to-phone' | 'phone-to-pc';
export type MediaKind = 'screen-video' | 'app-audio' | 'mic-audio';
export type VideoCodec = 'av1' | 'hevc' | 'h264';
export type Chroma = '420' | '422' | '444';

export interface VideoCodecSupport {
  codec: VideoCodec;
  canEncode: boolean;
  canDecode: boolean;
  /** Best chroma this device supports for this codec (encode and decode). */
  maxChroma: Chroma;
}

export interface MediaCapabilities {
  platform: Platform;
  video: VideoCodecSupport[];
  audioOpus: boolean;
}

export interface NegotiatedVideo {
  codec: VideoCodec;
  chroma: Chroma;
}

const CHROMA_RANK: Record<Chroma, number> = { '420': 0, '422': 1, '444': 2 };
// Preference among codecs of EQUAL chroma. HEVC preferred for low-latency
// real-time; AV1 next (PC->phone only); H.264 is the universal floor (SPEC §4).
const CODEC_PREF: Record<VideoCodec, number> = { hevc: 2, av1: 1, h264: 0 };

function minChroma(a: Chroma, b: Chroma): Chroma {
  return CHROMA_RANK[a] <= CHROMA_RANK[b] ? a : b;
}

/**
 * Choose the video codec + chroma for one direction. The encoder runs on the
 * SOURCE, the decoder on the SINK. Rules (SPEC §4):
 *   - AV1 is only ever used PC->phone (mid-range phones lack HW AV1 encode).
 *   - 4:4:4 chroma is prioritised OVER codec generation (text legibility).
 *   - H.264 is the mandatory floor; HEVC preferred when chroma ties.
 * Returns null if the two ends share no usable codec (should not happen once
 * H.264 is present on both).
 */
export function negotiateVideo(
  direction: MediaDirection,
  source: MediaCapabilities,
  sink: MediaCapabilities,
): NegotiatedVideo | null {
  const candidates: NegotiatedVideo[] = [];
  for (const enc of source.video) {
    if (!enc.canEncode) continue;
    if (enc.codec === 'av1' && direction !== 'pc-to-phone') continue; // AV1 only PC->phone
    const dec = sink.video.find((v) => v.codec === enc.codec && v.canDecode);
    if (!dec) continue;
    candidates.push({ codec: enc.codec, chroma: minChroma(enc.maxChroma, dec.maxChroma) });
  }
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      CHROMA_RANK[b.chroma] - CHROMA_RANK[a.chroma] || // 4:4:4 beats codec generation
      CODEC_PREF[b.codec] - CODEC_PREF[a.codec],
  );
  return candidates[0]!;
}

// ---- Capability profiles (SPEC §4) ------------------------------------------

/** Windows PC: universal H.264/HEVC; AV1 encode is GPU-dependent (probe at runtime). */
export const WINDOWS_MEDIA_CAPS: MediaCapabilities = {
  platform: 'windows',
  video: [
    { codec: 'h264', canEncode: true, canDecode: true, maxChroma: '444' },
    { codec: 'hevc', canEncode: true, canDecode: true, maxChroma: '444' },
    { codec: 'av1', canEncode: true, canDecode: true, maxChroma: '420' }, // encode: RTX40/RDNA3/Arc only
  ],
  audioOpus: true,
};

/** Stock Android phone: H.264/HEVC encode+decode; AV1 decode only (no HW encode). */
export const ANDROID_STOCK_MEDIA_CAPS: MediaCapabilities = {
  platform: 'android',
  video: [
    { codec: 'h264', canEncode: true, canDecode: true, maxChroma: '420' },
    { codec: 'hevc', canEncode: true, canDecode: true, maxChroma: '420' },
    { codec: 'av1', canEncode: false, canDecode: true, maxChroma: '420' },
  ],
  audioOpus: true,
};

// ---- Session control messages (carried inside the Noise transport) ----------

export interface MediaTrackRequest {
  kind: MediaKind;
  direction: MediaDirection;
}

export interface SessionOffer {
  t: 'session-offer';
  sessionId: string;
  subsystem: SubsystemKind;
  tracks: MediaTrackRequest[];
  /** WebRTC SDP offer (opaque here). */
  sdp: string;
}

export interface SessionAnswer {
  t: 'session-answer';
  sessionId: string;
  accepted: boolean;
  reason?: string;
  sdp?: string;
  /** Negotiated video params, when a video track was offered and accepted. */
  video?: NegotiatedVideo;
}

export interface IceCandidateMsg {
  t: 'ice-candidate';
  sessionId: string;
  candidate: string;
}

/** Move an active session to another of the user's devices (SPEC §2.3). */
export interface SessionHandoff {
  t: 'session-handoff';
  sessionId: string;
  toDeviceId: string;
}

export interface SessionClose {
  t: 'session-close';
  sessionId: string;
  reason?: string;
}

export type SessionControlMessage =
  | SessionOffer
  | SessionAnswer
  | IceCandidateMsg
  | SessionHandoff
  | SessionClose;
