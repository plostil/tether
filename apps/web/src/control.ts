/**
 * Application messages carried INSIDE the Noise transport (SecureLink.send).
 * Session control reuses the shared types from the protocol package; the web
 * client adds a capability handshake (`hello`), an input channel, a text
 * message, and a "please share your screen" nudge.
 */

import type { DeviceCapabilities, SessionControlMessage } from '@tether/protocol/browser';

/** One synthesized input event. Coordinates are normalized 0..1 of the
 *  source's screen, so the receiver scales them to its own resolution. */
export interface InputEvent {
  t: 'input';
  kind: 'pointer' | 'tap' | 'drag' | 'keys' | 'button';
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  text?: string;
  button?: string; // 'home' | 'volumeUp' | 'volumeDown' | 'lock'
  duration?: number; // seconds, for drag / long-press
}

export type ControlMessage =
  | SessionControlMessage
  | { t: 'hello'; name: string; capabilities: DeviceCapabilities; app: 'web' | 'virtual' | 'ios-bridge' }
  | { t: 'text'; body: string }
  | { t: 'view-request'; mode: 'view' | 'control' }
  | { t: 'input-unsupported'; reason: string }
  | InputEvent;

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
