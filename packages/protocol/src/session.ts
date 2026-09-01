/**
 * End-to-end session negotiation (SPEC §2). These messages travel INSIDE the
 * encrypted relay payload and are never seen by the broker.
 *
 * `negotiateSession` is the single choke point that enforces the spec's
 * feasibility verdicts: a session may only request a capability both peers
 * actually have, and the blocked configurations (unattended capture,
 * split-duplex calling, control of an uncontrollable device) are rejected here
 * rather than failing mysteriously at runtime.
 */

import type { DeviceCapabilities } from './capabilities.ts';
import type { MediaCapabilities } from './media.ts';

export type SubsystemKind =
  | 'remote-view' // one peer views the other's screen
  | 'remote-control' // one peer injects input into the other
  | 'audio-route' // move media/output audio to the other device
  | 'call-handoff'; // move a live call between devices

/**
 * Peer capability advertisement, exchanged INSIDE the Noise transport right
 * after pairing (never via the broker's register message — the broker treats
 * capabilities as opaque and the peer would not see them authenticated).
 * Each side stores the other's caps and feeds them to `negotiateSession` /
 * `negotiateVideo` when offering or answering a session.
 */
export interface PeerCapsMsg {
  t: 'peer-caps';
  device: DeviceCapabilities;
  media?: MediaCapabilities;
}

export interface SessionRequest {
  kind: SubsystemKind;
  /** The device that originates the stream/control (e.g. the screen being shared). */
  source: string;
  /** The device that consumes it (e.g. the one displaying / injecting). */
  sink: string;
  /**
   * For audio-route/call-handoff: does the request try to split the acoustic
   * loop (mic on one device, speaker on the other)? Always rejected in v1.
   */
  splitDuplexLoop?: boolean;
  /** For call-handoff: is the underlying call cellular (vs the app's own VoIP)? */
  cellular?: boolean;
}

export type NegotiationResult =
  | { ok: true; request: SessionRequest }
  | { ok: false; reason: string };

function reject(reason: string): NegotiationResult {
  return { ok: false, reason };
}

/**
 * @param req         requested session
 * @param sourceCaps  capabilities of req.source
 * @param sinkCaps    capabilities of req.sink
 */
export function negotiateSession(
  req: SessionRequest,
  sourceCaps: DeviceCapabilities,
  sinkCaps: DeviceCapabilities,
): NegotiationResult {
  switch (req.kind) {
    case 'remote-view': {
      if (!sourceCaps.remoteView.canBeViewed) return reject('source cannot export its screen');
      if (!sinkCaps.remoteView.canView) return reject('sink cannot render a remote screen');
      return { ok: true, request: req };
    }

    case 'remote-control': {
      // The sink is the device being controlled; the source drives it.
      if (!sourceCaps.remoteControl.canControlPeer) return reject('source cannot drive a peer');
      if (sinkCaps.remoteControl.controllableVia === 'none') {
        return reject('sink is not controllable on its platform (e.g. iOS: no injection API)');
      }
      return { ok: true, request: req };
    }

    case 'audio-route': {
      if (req.splitDuplexLoop) {
        return reject('split mic/speaker loop is unsupported in v1 (distributed AEC, SPEC §2.2)');
      }
      if (!sourceCaps.audioRouting.canExportMediaAudio) {
        return reject('source cannot export media audio');
      }
      return { ok: true, request: req };
    }

    case 'call-handoff': {
      if (req.splitDuplexLoop) {
        return reject('call cannot split mic/speaker across devices (SPEC §2.2)');
      }
      if (req.cellular) {
        // Cellular audio is untouchable; handoff must ride OS Bluetooth HFP,
        // which requires the receiving device to be OS-pairable as an HFP unit.
        const receiver = sinkCaps.callHandoff;
        if (!receiver.canActAsHfpUnit || receiver.method !== 'os-bluetooth-hfp') {
          return reject('cellular handoff requires the receiver to act as an OS Bluetooth HFP unit');
        }
        return { ok: true, request: req };
      }
      // Own-VoIP handoff: both peers must speak the app's VoIP path.
      if (sourceCaps.callHandoff.method === 'none' || sinkCaps.callHandoff.method === 'none') {
        return reject('a peer cannot participate in call handoff');
      }
      return { ok: true, request: req };
    }

    default:
      return reject(`unknown subsystem: ${(req as SessionRequest).kind}`);
  }
}
