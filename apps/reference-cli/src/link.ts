/**
 * SecureLink — the reference client-side of the Tether protocol, in Node/TS.
 *
 * This is the exact sequence the Android (Kotlin) and Windows (C++) clients must
 * reproduce:
 *   1. Connect to the rendezvous broker and register (deviceId = key fingerprint).
 *   2. Run the Noise_IK handshake END-TO-END over the broker's opaque relay.
 *   3. Verify the peer's authenticated static key fingerprints to the expected
 *      device id (the one scanned from the QR).
 *   4. Exchange application messages over the resulting transport ciphers.
 *
 * The broker never sees a handshake or transport plaintext — only base64 blobs.
 * Uses Node's global WebSocket (Node >= 22).
 */

import {
  NoiseHandshake,
  deviceIdFromPublicKey,
  PROTOCOL_VERSION,
  type StaticKeypair,
  type TransportPair,
} from '@tether/protocol';

export interface LinkOptions {
  serverUrl: string;
  staticKeypair: StaticKeypair;
  role: 'initiator' | 'responder';
  /** Initiator only: the peer's static key + device id, as if scanned from a QR. */
  peerStatic?: Uint8Array;
  peerDeviceId?: string;
  onMessage?: (plaintext: Buffer) => void;
  log?: (line: string) => void;
}

export class SecureLink {
  readonly deviceId: string;
  private readonly opts: LinkOptions;
  private ws: WebSocket | null = null;
  private hs: NoiseHandshake | null = null;
  private transport: TransportPair | null = null;
  private remoteId: string | null = null;

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
    this.ws!.send(
      JSON.stringify({ t: 'relay', to, payload: Buffer.from(payload).toString('base64') }),
    );
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
          publicKey: Buffer.from(this.opts.staticKeypair.publicKey).toString('base64'),
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
      this.hs = NoiseHandshake.initiator(this.opts.staticKeypair, this.opts.peerStatic);
      this.log(`initiator: sending handshake msg1 -> ${short(this.remoteId)}`);
      this.relay(this.remoteId, this.hs.writeMessage());
    } else {
      this.hs = NoiseHandshake.responder(this.opts.staticKeypair);
      this.log('responder: waiting for handshake msg1…');
    }
    return this.paired;
  }

  /** Send an encrypted application message to the peer. */
  send(message: Uint8Array | string): void {
    if (!this.transport) throw new Error('not paired yet');
    const pt = typeof message === 'string' ? Buffer.from(message) : message;
    this.relay(this.remoteId!, this.transport.send.encryptWithAd(new Uint8Array(0), pt));
  }

  close(): void {
    this.ws?.close();
  }

  private onServerMessage(text: string): void {
    const msg = JSON.parse(text) as { t: string; [k: string]: unknown };
    switch (msg.t) {
      case 'registered':
        this.log(`registered as ${short(this.deviceId)}`);
        this.markRegistered();
        return;
      case 'deliver':
        this.onDeliver(msg.from as string, Buffer.from(msg.payload as string, 'base64'));
        return;
      case 'error':
        this.failPaired(new Error(`broker error: ${msg.code} ${msg.message ?? ''}`));
        return;
    }
  }

  private onDeliver(from: string, payload: Buffer): void {
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
