/**
 * Browser SecureLink — the same client sequence as apps/reference-cli/src/link.ts
 * (which native clients also mirror), on browser APIs:
 *   1. Connect to the broker over WebSocket and register (deviceId = key fingerprint).
 *   2. Run the Noise_IK handshake END-TO-END over the broker's opaque relay.
 *   3. Verify the peer's authenticated static key fingerprints to the expected id.
 *   4. Exchange application messages over the resulting transport ciphers.
 *
 * Differences from the reference CLI, both needed for a real client:
 *   - The initiator `watch`es the peer and only sends msg1 once the broker says
 *     the peer is online (the CLI assumed you started the responder first).
 *   - The session token from `registered` is kept, to authorize GET /ice.
 */

import { CoreNoiseHandshake, PROTOCOL_VERSION, type CoreTransportPair } from '@tether/protocol/browser';
import type { ServerMessage, StaticKeypair } from '@tether/protocol/browser';
import { deviceIdFromPublicKey, nobleNoisePrimitives } from './crypto-noble.ts';
import { fromB64, toB64 } from './b64.ts';

export interface LinkOptions {
  serverUrl: string;
  staticKeypair: StaticKeypair;
  role: 'initiator' | 'responder';
  /** Initiator only: the peer's static key + device id, from the pairing QR/URL. */
  peerStatic?: Uint8Array;
  peerDeviceId?: string;
  onMessage?: (plaintext: Uint8Array) => void;
  onPeerStatus?: (online: boolean) => void;
  log?: (line: string) => void;
}

export class SecureLink {
  readonly deviceId: string;
  sessionToken: string | null = null;
  private readonly opts: LinkOptions;
  private ws: WebSocket | null = null;
  private hs: CoreNoiseHandshake | null = null;
  private transport: CoreTransportPair | null = null;
  private remoteId: string | null = null;
  private msg1Sent = false;

  private registered!: Promise<void>;
  private markRegistered!: () => void;
  private failRegistered!: (e: Error) => void;
  private paired!: Promise<void>;
  private markPaired!: () => void;
  private failPaired!: (e: Error) => void;

  constructor(opts: LinkOptions) {
    this.opts = opts;
    this.deviceId = deviceIdFromPublicKey(opts.staticKeypair.publicKey);
    this.registered = new Promise((res, rej) => {
      this.markRegistered = res;
      this.failRegistered = rej;
    });
    this.paired = new Promise((res, rej) => {
      this.markPaired = res;
      this.failPaired = rej;
    });
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private relay(to: string, payload: Uint8Array): void {
    this.ws!.send(JSON.stringify({ t: 'relay', to, payload: toB64(payload) }));
  }

  /** Connect and register; resolves once the broker acknowledges registration. */
  connect(): Promise<void> {
    const ws = new WebSocket(this.opts.serverUrl);
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          t: 'register',
          protocolVersion: PROTOCOL_VERSION,
          deviceId: this.deviceId,
          publicKey: toB64(this.opts.staticKeypair.publicKey),
          capabilities: {},
        }),
      );
    });
    ws.addEventListener('message', (e) => this.onServerMessage(String(e.data)));
    ws.addEventListener('error', () => this.failRegistered(new Error('websocket error')));
    ws.addEventListener('close', () => {
      if (!this.transport) this.failPaired(new Error('connection closed before pairing completed'));
    });
    return this.registered;
  }

  /** Perform the Noise_IK handshake; resolves once the transport is ready. */
  pair(): Promise<void> {
    if (this.opts.role === 'initiator') {
      if (!this.opts.peerStatic || !this.opts.peerDeviceId) {
        throw new Error('initiator needs peerStatic + peerDeviceId (from the QR)');
      }
      this.remoteId = this.opts.peerDeviceId;
      this.hs = CoreNoiseHandshake.initiator(nobleNoisePrimitives, this.opts.staticKeypair, this.opts.peerStatic);
      // Don't fire msg1 blindly: watch the peer and send once it's online.
      this.log(`initiator: watching ${short(this.remoteId)}…`);
      this.ws!.send(JSON.stringify({ t: 'watch', deviceId: this.remoteId }));
    } else {
      this.hs = CoreNoiseHandshake.responder(nobleNoisePrimitives, this.opts.staticKeypair);
      this.log('responder: waiting for handshake msg1…');
    }
    return this.paired;
  }

  get isPaired(): boolean {
    return this.transport !== null;
  }

  /** Send an encrypted application message to the peer. */
  send(message: Uint8Array | string): void {
    if (!this.transport) throw new Error('not paired yet');
    const pt = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    this.relay(this.remoteId!, this.transport.send.encryptWithAd(new Uint8Array(0), pt));
  }

  close(): void {
    this.ws?.close();
  }

  private sendMsg1(): void {
    if (this.msg1Sent) return;
    this.msg1Sent = true;
    this.log(`initiator: sending handshake msg1 -> ${short(this.remoteId!)}`);
    this.relay(this.remoteId!, this.hs!.writeMessage());
  }

  private onServerMessage(text: string): void {
    const msg = JSON.parse(text) as ServerMessage;
    switch (msg.t) {
      case 'registered':
        this.sessionToken = msg.sessionToken;
        this.log(`registered as ${short(this.deviceId)}`);
        this.markRegistered();
        return;
      case 'deliver':
        this.onDeliver(msg.from, fromB64(msg.payload));
        return;
      case 'peer-status':
        this.opts.onPeerStatus?.(msg.online);
        if (this.opts.role === 'initiator' && msg.deviceId === this.remoteId && msg.online && this.hs && !this.transport) {
          this.sendMsg1();
        }
        return;
      case 'error':
        this.failPaired(new Error(`broker error: ${msg.code} ${msg.message ?? ''}`));
        return;
    }
  }

  private onDeliver(from: string, payload: Uint8Array): void {
    // Transport phase: decrypt and surface to the caller.
    if (this.transport) {
      this.opts.onMessage?.(this.transport.recv.decryptWithAd(new Uint8Array(0), payload));
      return;
    }

    // Handshake phase.
    const hs = this.hs!;
    if (this.opts.role === 'responder' && !this.remoteId) {
      this.remoteId = from; // learn the initiator's claimed device id
      this.log(`responder: received msg1 from ${short(from)}`);
    }

    hs.readMessage(payload);

    if (hs.isMyTurn) {
      this.log(`${this.opts.role}: replying with handshake msg2 -> ${short(this.remoteId!)}`);
      this.relay(this.remoteId!, hs.writeMessage());
    }

    if (hs.isComplete) {
      // Bind the authenticated key to the expected identity (anti-MITM, SPEC §4).
      const authenticatedId = deviceIdFromPublicKey(hs.remoteStaticKey!);
      if (authenticatedId !== this.remoteId) {
        this.failPaired(
          new Error(
            `identity mismatch: peer key fingerprints to ${short(authenticatedId)} but expected ${short(this.remoteId!)}`,
          ),
        );
        return;
      }
      this.transport = hs.split();
      this.log(`${this.opts.role}: handshake complete, peer verified as ${short(authenticatedId)}`);
      this.markPaired();
    }
  }
}

function short(id: string): string {
  return id.slice(0, 8) + '…';
}
