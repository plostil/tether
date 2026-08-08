/**
 * Wire protocol between a client and the rendezvous/signaling broker.
 *
 * ZERO-TRUST INVARIANT (SPEC §4, README invariant 1): the broker only ever
 * routes messages by device ID and relays opaque `payload` blobs between paired
 * peers. It never parses a relay payload. The Noise handshake, ICE/SDP
 * exchange, and all session control ride inside those blobs, end-to-end
 * encrypted once the Noise session is up. Do not add a message type that
 * requires the server to understand session contents.
 */

export const PROTOCOL_VERSION = 1;

/** Base64 (standard) encoding of a raw byte payload the server won't inspect. */
export type Base64 = string;

// ---- Client -> Server -------------------------------------------------------

export interface RegisterMsg {
  t: 'register';
  protocolVersion: number;
  deviceId: string;
  /** Raw 32-byte X25519 public key, base64. Server verifies it fingerprints to deviceId. */
  publicKey: Base64;
  /** Advertised capabilities (see capabilities.ts). Server treats as opaque metadata. */
  capabilities: unknown;
}

/** Ask the broker to forward an opaque blob to a peer by device ID. */
export interface RelayMsg {
  t: 'relay';
  to: string;
  payload: Base64;
}

/** Ask to be notified when a specific peer comes online / goes offline. */
export interface WatchMsg {
  t: 'watch';
  deviceId: string;
}

export interface PingMsg {
  t: 'ping';
}

export type ClientMessage = RegisterMsg | RelayMsg | WatchMsg | PingMsg;

// ---- Server -> Client -------------------------------------------------------

export interface RegisteredMsg {
  t: 'registered';
  /** Opaque session token for this connection; not a long-term secret. */
  sessionToken: string;
  heartbeatIntervalMs: number;
}

/** A relayed blob arriving from a peer. `from` is authenticated by registration. */
export interface DeliverMsg {
  t: 'deliver';
  from: string;
  payload: Base64;
}

export interface PeerStatusMsg {
  t: 'peer-status';
  deviceId: string;
  online: boolean;
}

export interface ErrorMsg {
  t: 'error';
  code: ErrorCode;
  message: string;
}

export interface PongMsg {
  t: 'pong';
}

export type ServerMessage = RegisteredMsg | DeliverMsg | PeerStatusMsg | ErrorMsg | PongMsg;

export type ErrorCode =
  | 'bad-message'
  | 'unsupported-version'
  | 'id-key-mismatch'
  | 'not-registered'
  | 'peer-offline'
  | 'rate-limited';

// ---- Runtime guards (native TS strip-types has no reflection) ----------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (!isObj(raw) || typeof raw.t !== 'string') return null;
  switch (raw.t) {
    case 'register':
      return typeof raw.deviceId === 'string' &&
        typeof raw.publicKey === 'string' &&
        typeof raw.protocolVersion === 'number'
        ? (raw as unknown as RegisterMsg)
        : null;
    case 'relay':
      return typeof raw.to === 'string' && typeof raw.payload === 'string'
        ? (raw as unknown as RelayMsg)
        : null;
    case 'watch':
      return typeof raw.deviceId === 'string' ? (raw as unknown as WatchMsg) : null;
    case 'ping':
      return { t: 'ping' };
    default:
      return null;
  }
}

export function errorMsg(code: ErrorCode, message: string): ErrorMsg {
  return { t: 'error', code, message };
}
