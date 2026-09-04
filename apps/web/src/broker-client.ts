/**
 * BrokerClient — owns exactly ONE WebSocket for ONE device identity.
 *
 * Responsibilities: connect + register (deviceId = key fingerprint), keep the
 * registration alive across drops (reconnect with backoff, re-watch, offline
 * awareness), relay opaque blobs, and surface peer presence. The Noise
 * handshake and transport live one layer up in SecureLink, which consumes this
 * client's events. Splitting them lets the Devices screen watch many peers over
 * one socket and lets the demo's virtual device own a second, independent one.
 */

import { PROTOCOL_VERSION, type DeviceCapabilities, type ServerMessage } from '@tether/protocol/browser';
import { fromB64, toB64 } from './b64.ts';

export type BrokerState =
  | 'idle'
  | 'connecting'
  | 'registered'
  | 'reconnecting'
  | 'offline'
  | 'failed'
  | 'closed';

export interface LinkFault {
  kind:
    | 'self-pair'
    | 'broker'
    | 'displaced'
    | 'identity-mismatch'
    | 'handshake'
    | 'timeout'
    | 'network'
    | 'peer-closed';
  message: string;
  retryable?: boolean;
}

export type BrokerEvent =
  | { t: 'state'; state: BrokerState; fault?: LinkFault; attempt?: number }
  | { t: 'deliver'; from: string; payload: Uint8Array }
  | { t: 'peer-status'; deviceId: string; online: boolean }
  | { t: 'error'; code: string; message: string };

export interface BrokerClientOptions {
  serverUrl: string;
  staticKeypair: { privateKey: Uint8Array; publicKey: Uint8Array };
  deviceId: string;
  capabilities: DeviceCapabilities;
  reconnect?: boolean;
  log?: (line: string) => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/**
 * The broker surface SecureLink and the screens depend on. The WebSocket
 * client below is the real one; loopback.ts provides an in-memory one for the
 * server-less demo so everything above the transport runs unchanged.
 */
export interface IBrokerClient {
  readonly deviceId: string;
  state: BrokerState;
  sessionToken: string | null;
  fault: LinkFault | null;
  readonly isRegistered: boolean;
  on(handler: (e: BrokerEvent) => void): () => void;
  connect(): Promise<void>;
  watch(deviceId: string): void;
  unwatch(deviceId: string): void;
  relay(to: string, payload: Uint8Array): void;
  close(): void;
}

export class BrokerClient implements IBrokerClient {
  readonly deviceId: string;
  state: BrokerState = 'idle';
  sessionToken: string | null = null;
  fault: LinkFault | null = null;

  private readonly opts: BrokerClientOptions;
  private ws: WebSocket | null = null;
  private readonly watching = new Set<string>();
  private readonly handlers = new Set<(e: BrokerEvent) => void>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private userClosed = false;
  private firstRegister: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private onlineListener: (() => void) | null = null;
  private offlineListener: (() => void) | null = null;

  constructor(opts: BrokerClientOptions) {
    this.opts = opts;
    this.deviceId = opts.deviceId;
  }

  on(handler: (e: BrokerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(e: BrokerEvent): void {
    for (const h of this.handlers) h(e);
  }

  private setState(state: BrokerState, fault?: LinkFault): void {
    this.state = state;
    this.fault = fault ?? null;
    this.emit({ t: 'state', state, fault, attempt: this.attempt });
  }

  /** Connect and register; resolves once the broker acknowledges registration. */
  connect(): Promise<void> {
    this.userClosed = false;
    this.installNetworkListeners();
    return new Promise<void>((resolve, reject) => {
      this.firstRegister = { resolve, reject };
      this.open();
    });
  }

  private open(): void {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.serverUrl);
    } catch {
      this.scheduleReconnect({
        kind: 'network',
        message: `Cannot reach the broker at ${this.opts.serverUrl}`,
        retryable: true,
      });
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          t: 'register',
          protocolVersion: PROTOCOL_VERSION,
          deviceId: this.deviceId,
          publicKey: toB64(this.opts.staticKeypair.publicKey),
          capabilities: this.opts.capabilities,
        }),
      );
    });
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
    ws.addEventListener('close', (ev) => this.onClose(ev.code, ev.reason));
  }

  private onMessage(text: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(text) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.t) {
      case 'registered':
        this.sessionToken = msg.sessionToken;
        this.attempt = 0;
        this.setState('registered');
        this.opts.log?.(`registered as ${this.deviceId.slice(0, 8)}…`);
        // Re-arm every watch after a (re)registration.
        for (const id of this.watching) this.sendWatch(id);
        this.firstRegister?.resolve();
        this.firstRegister = null;
        return;
      case 'deliver':
        this.emit({ t: 'deliver', from: msg.from, payload: fromB64(msg.payload) });
        return;
      case 'peer-status':
        this.emit({ t: 'peer-status', deviceId: msg.deviceId, online: msg.online });
        return;
      case 'error': {
        // A displaced registration is fatal: another tab on this origin holds
        // the same identity. Reconnecting would ping-pong, so we stop.
        if (msg.code === 'not-registered' && /replaced/i.test(msg.message ?? '')) {
          this.fatalDisplaced();
          return;
        }
        this.emit({ t: 'error', code: msg.code, message: msg.message });
        if (this.firstRegister && (msg.code === 'id-key-mismatch' || msg.code === 'unsupported-version')) {
          const fault: LinkFault = { kind: 'broker', message: `${msg.code}: ${msg.message}`, retryable: false };
          this.setState('failed', fault);
          this.firstRegister.reject(new Error(fault.message));
          this.firstRegister = null;
        }
        return;
      }
    }
  }

  private fatalDisplaced(): void {
    this.userClosed = true; // suppress reconnect
    const fault: LinkFault = {
      kind: 'displaced',
      message:
        'Another tab or window on this origin is using this device identity. Close it, or open the join link in a different browser or profile.',
      retryable: false,
    };
    this.setState('failed', fault);
    this.firstRegister?.reject(new Error(fault.message));
    this.firstRegister = null;
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  private onClose(code: number, reason: string): void {
    if (code === 4001 || /replaced/i.test(reason)) {
      this.fatalDisplaced();
      return;
    }
    if (this.userClosed) {
      this.setState('closed');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setState('offline');
      return; // the 'online' listener will reconnect
    }
    this.scheduleReconnect({
      kind: 'network',
      message: 'Lost the connection to the broker. Reconnecting…',
      retryable: true,
    });
  }

  private scheduleReconnect(fault: LinkFault): void {
    if (this.opts.reconnect === false) {
      this.setState('failed', fault);
      this.firstRegister?.reject(new Error(fault.message));
      this.firstRegister = null;
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    this.setState('reconnecting', fault);
    this.reconnectTimer = setTimeout(() => this.open(), delay + Math.random() * 300);
  }

  private installNetworkListeners(): void {
    if (typeof window === 'undefined' || this.onlineListener) return;
    this.onlineListener = () => {
      if (this.userClosed) return;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.attempt = 0;
      this.open();
    };
    this.offlineListener = () => {
      if (!this.userClosed) this.setState('offline');
    };
    window.addEventListener('online', this.onlineListener);
    window.addEventListener('offline', this.offlineListener);
  }

  private sendWatch(deviceId: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'watch', deviceId }));
    }
  }

  watch(deviceId: string): void {
    this.watching.add(deviceId);
    this.sendWatch(deviceId);
  }

  unwatch(deviceId: string): void {
    this.watching.delete(deviceId);
  }

  relay(to: string, payload: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('broker socket not open');
    }
    this.ws.send(JSON.stringify({ t: 'relay', to, payload: toB64(payload) }));
  }

  get isRegistered(): boolean {
    return this.state === 'registered';
  }

  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.onlineListener) window.removeEventListener('online', this.onlineListener);
    if (this.offlineListener) window.removeEventListener('offline', this.offlineListener);
    this.onlineListener = this.offlineListener = null;
    try {
      this.ws?.close(1000, 'client closed');
    } catch {
      /* already gone */
    }
    this.setState('closed');
  }
}
