/** The single app state shape held by the store. */

import type { DeviceCapabilities } from '@tether/protocol/browser';
import type { LinkFault } from '../broker-client.ts';
import type { LinkState } from '../secure-link.ts';
import type { HandshakeStep, StepStatus } from '../secure-link.ts';
import type { RtcStats } from '../rtc.ts';
import type { Mode } from '../capabilities.ts';

export interface LinkView {
  state: LinkState | 'idle';
  fault: LinkFault | null;
  steps: Partial<Record<HandshakeStep, StepStatus>>;
  peer: { id: string; name: string | null; caps: DeviceCapabilities | null } | null;
  sessionFingerprint: string | null;
}

export interface SessionView {
  kind: Mode | null;
  rtcState: RTCPeerConnectionState | null;
  dtlsState: string | null;
  stats: RtcStats | null;
  hasVideo: boolean;
  fault: string | null;
  refused: string | null;
}

export interface AppState {
  config: { demo: boolean; turn: boolean };
  online: boolean;
  mode: Mode | null;
  link: LinkView;
  session: SessionView;
  presence: Record<string, boolean>;
}

export const initialState: AppState = {
  config: { demo: false, turn: false },
  online: true,
  mode: null,
  link: { state: 'idle', fault: null, steps: {}, peer: null, sessionFingerprint: null },
  session: { kind: null, rtcState: null, dtlsState: null, stats: null, hasVideo: false, fault: null, refused: null },
  presence: {},
};
