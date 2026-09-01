/**
 * Application messages carried INSIDE the Noise transport (SecureLink.send).
 * Session control reuses the shared types from media.ts; the web client adds
 * a text/clipboard message and a "please share your screen" nudge (the actual
 * getDisplayMedia call still needs a user gesture on the PC).
 */

import type { PeerCapsMsg, SessionControlMessage } from '@tether/protocol/browser';

export type ControlMessage =
  | SessionControlMessage
  | PeerCapsMsg
  | { t: 'text'; body: string }
  | { t: 'view-request' };

export function encodeControl(msg: ControlMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

export function decodeControl(payload: Uint8Array): ControlMessage | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as ControlMessage;
  } catch {
    return null;
  }
}
