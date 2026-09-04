/**
 * Browser SecureLink — the Noise_IK session over a BrokerClient.
 *
 * The pairing sequence is unchanged from the reference client: register, run
 * Noise_IK end-to-end over the broker's opaque relay, verify the peer's
 * authenticated static key fingerprints to the expected id, then exchange
 * transport frames. What is new here is the RELIABILITY around it — this is a
 * live, user-facing link, not a one-shot script:
 *
 *   - a state machine (idle → registering → waiting-peer → handshaking →
 *     paired, plus degraded / failed / closed) that maps 1:1 to UI,
 *   - msg1 is (re)sent on every peer 'online' transition and by retry(), each
 *     time with a FRESH handshake object (a Noise handshake is single-use),
 *   - a 15 s handshake deadline so a dead peer surfaces instead of hanging,
 *   - responder re-arm: a fresh 96-byte msg1 rebuilds the responder handshake,
 *     so a reloaded initiator re-pairs without the host reloading,
 *   - a self-pair guard (peer id == our id) that turns the old silent
 *     same-origin hang into a clear fault,
 *   - every delivered frame is decoded inside try/catch → a typed fault.
 *
 * The Noise primitives and the handshake bytes are IDENTICAL to before
 * (CoreNoiseHandshake + nobleNoisePrimitives); none of the wire format changes.
 */

import {
  base32Encode,
  CoreNoiseHandshake,
  displayFingerprint,
  type CoreTransportPair,
  type StaticKeypair,
} from '@tether/protocol/browser';
import { deviceIdFromPublicKey, nobleNoisePrimitives } from './crypto-noble.ts';
import { BrokerClient, type BrokerEvent, type LinkFault } from './broker-client.ts';

/** IK message 1 length: 32 (e) + 32+16 (enc static + tag) + 16 (enc empty payload tag). */
const IK_MSG1_LEN = 96;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

export type LinkState =
  | 'idle'
  | 'registering'
  | 'waiting-peer'
  | 'handshaking'
  | 'paired'
  | 'degraded'
  | 'failed'
  | 'closed';

export type HandshakeStep = 'register' | 'watch' | 'msg1' | 'msg2' | 'verified';
export type StepStatus = 'pending' | 'active' | 'done';

export type LinkEvent =
  | { t: 'state'; state: LinkState; fault?: LinkFault }
  | { t: 'handshake'; step: HandshakeStep; status: StepStatus }
  | { t: 'peer-status'; online: boolean }
  | { t: 'message'; plaintext: Uint8Array }
  | { t: 'warn'; message: string };

export interface SecureLinkOptions {
  role: 'initiator' | 'responder';
  /** Initiator only: the peer's static key + id, from the QR / join code. */
  peerStatic?: Uint8Array;
  peerDeviceId?: string;
  handshakeTimeoutMs?: number;
  onEvent?: (e: LinkEvent) => void;
}

export class SecureLink {
  readonly deviceId: string;
  state: LinkState = 'idle';
  fault: LinkFault | null = null;
  /** The peer's authenticated static public key, once paired (for "remember"). */
  peerPublicKey: Uint8Array | null = null;
  /** The Noise handshake hash — a channel binding / short-auth-string source. */
  channelBinding: Uint8Array | null = null;
  /** Human-comparable session fingerprint derived from the handshake hash. */
  sessionFingerprint: string | null = null;

  private readonly client: BrokerClient;
  private readonly opts: SecureLinkOptions;
  private readonly staticKeypair: StaticKeypair;
  private hs: CoreNoiseHandshake | null = null;
  private transport: CoreTransportPair | null = null;
  private remoteId: string | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private everPaired = false;
  private peerOnline = false;
  private unsub: (() => void) | null = null;

  private paired!: Promise<void>;
  private markPaired!: () => void;
  private failPaired!: (e: Error) => void;
  private settled = false;

  constructor(client: BrokerClient, staticKeypair: StaticKeypair, opts: SecureLinkOptions) {
    this.client = client;
    this.staticKeypair = staticKeypair;
    this.opts = opts;
    this.deviceId = client.deviceId;
    this.resetPairedPromise();
  }

  /** (Re)create the paired promise. The internal no-op catch defuses Node's
   *  unhandled-rejection crash when a caller uses `void link.pair()` (as the
   *  responder does); a real awaiter of `pair()` still observes the rejection. */
  private resetPairedPromise(): void {
    this.paired = new Promise<void>((res, rej) => {
      this.markPaired = res;
      this.failPaired = rej;
    });
    this.paired.catch(() => {});
  }

  private emit(e: LinkEvent): void {
    this.opts.onEvent?.(e);
  }

  private setState(state: LinkState, fault?: LinkFault): void {
    this.state = state;
    this.fault = fault ?? null;
    this.emit({ t: 'state', state, fault });
  }

  private step(step: HandshakeStep, status: StepStatus): void {
    this.emit({ t: 'handshake', step, status });
  }

  private fail(fault: LinkFault): void {
    this.clearDeadline();
    this.setState('failed', fault);
    if (!this.settled) {
      this.settled = true;
      this.failPaired(new Error(fault.message));
    }
  }

  private clearDeadline(): void {
    if (this.deadline) {
      clearTimeout(this.deadline);
      this.deadline = null;
    }
  }

  /** Run the handshake; resolves once the transport is ready. */
  pair(): Promise<void> {
    if (this.opts.role === 'initiator') {
      if (!this.opts.peerStatic || !this.opts.peerDeviceId) {
        throw new Error('initiator needs peerStatic + peerDeviceId (from the QR / code)');
      }
      if (this.opts.peerDeviceId === this.deviceId) {
        this.fail({
          kind: 'self-pair',
          message:
            'This link points back at this same device. Open the join link in a different browser or profile, or use two devices.',
          retryable: false,
        });
        return this.paired;
      }
      this.remoteId = this.opts.peerDeviceId;
    }

    this.setState('registering');
    this.step('register', this.client.isRegistered ? 'done' : 'active');
    this.unsub = this.client.on((e) => this.onBrokerEvent(e));

    if (this.client.isRegistered) this.onRegistered();
    return this.paired;
  }

  private onRegistered(): void {
    this.step('register', 'done');
    if (this.opts.role === 'initiator') {
      this.step('watch', 'active');
      this.setState('waiting-peer');
      this.client.watch(this.remoteId!);
    } else {
      this.step('watch', 'done');
      this.setState('waiting-peer');
      // Responder waits for msg1; arms a fresh handshake lazily on receipt.
    }
  }

  private onBrokerEvent(e: BrokerEvent): void {
    switch (e.t) {
      case 'state':
        if (e.state === 'registered') {
          if (this.state === 'registering') this.onRegistered();
          else if (this.everPaired) this.recoverAfterReconnect();
        } else if (e.state === 'reconnecting' || e.state === 'offline') {
          if (this.everPaired && this.state === 'paired') {
            this.teardownTransport();
            this.setState('degraded', e.fault ?? undefined);
          }
        } else if (e.state === 'failed') {
          this.fail(e.fault ?? { kind: 'network', message: 'connection failed', retryable: true });
        }
        return;
      case 'peer-status':
        if (e.deviceId === this.remoteId) {
          this.emit({ t: 'peer-status', online: e.online });
          const edge = e.online && !this.peerOnline;
          this.peerOnline = e.online;
          // Fire msg1 only on a genuine offline→online edge. Firing on every
          // notification would rebuild the handshake mid-flight, and the
          // stale msg2 would then fail to decrypt.
          if (this.opts.role === 'initiator' && edge && !this.transport) {
            this.step('watch', 'done');
            this.sendMsg1();
          } else if (!e.online && this.state === 'paired') {
            this.teardownTransport();
            this.setState('degraded', { kind: 'peer-closed', message: 'The peer went offline.', retryable: true });
          }
        }
        return;
      case 'deliver':
        try {
          this.onDeliver(e.from, e.payload);
        } catch (err) {
          this.fail({ kind: 'handshake', message: `Handshake failed: ${(err as Error).message}`, retryable: true });
        }
        return;
      case 'error':
        // peer-offline in reply to a relay is non-fatal; just wait for 'online'.
        if (e.code === 'peer-offline') return;
        return;
    }
  }

  private sendMsg1(): void {
    // Fresh handshake each attempt — a Noise handshake object is single-use.
    this.hs = CoreNoiseHandshake.initiator(nobleNoisePrimitives, this.staticKeypair, this.opts.peerStatic!);
    this.setState('handshaking');
    this.step('msg1', 'active');
    try {
      this.client.relay(this.remoteId!, this.hs.writeMessage());
    } catch {
      // socket not open yet; the next 'online'/'registered' will retry
      return;
    }
    this.step('msg1', 'done');
    this.step('msg2', 'active');
    this.armDeadline();
  }

  private armDeadline(): void {
    this.clearDeadline();
    const ms = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.deadline = setTimeout(() => {
      if (!this.transport) {
        this.fail({
          kind: 'timeout',
          message:
            'The peer did not answer the handshake. If it regenerated its identity, forget it and pair again.',
          retryable: true,
        });
      }
    }, ms);
  }

  /** Retry a stalled/failed handshake (initiator only). */
  retry(): void {
    if (this.opts.role !== 'initiator' || this.transport) return;
    this.settled = false;
    this.resetPairedPromise();
    this.sendMsg1();
  }

  private onDeliver(from: string, payload: Uint8Array): void {
    // Transport phase.
    if (this.transport) {
      // A fresh msg1 (exact IK length) means the initiator reconnected and is
      // re-pairing; rebuild the responder handshake rather than trying to
      // decrypt it as a transport frame.
      if (this.opts.role === 'responder' && payload.length === IK_MSG1_LEN && this.looksLikeMsg1(payload)) {
        this.rearmResponder(from, payload);
        return;
      }
      try {
        this.emit({ t: 'message', plaintext: this.transport.recv.decryptWithAd(new Uint8Array(0), payload) });
      } catch {
        // A stray, undecryptable frame (e.g. a duplicate handshake msg2 that
        // raced our completion) must not kill a live session. Drop it.
        this.emit({ t: 'warn', message: 'Dropped an out-of-sync frame on the encrypted channel.' });
      }
      return;
    }

    // Handshake phase.
    if (this.opts.role === 'responder') {
      this.beginResponder(from);
    }
    const hs = this.hs!;
    this.setState('handshaking');
    hs.readMessage(payload);
    if (this.opts.role === 'responder') this.step('msg1', 'done');

    if (hs.isMyTurn) {
      this.step('msg2', 'active');
      this.client.relay(this.remoteId!, hs.writeMessage());
    }

    if (hs.isComplete) this.complete(hs);
  }

  private beginResponder(from: string): void {
    if (!this.remoteId) {
      this.remoteId = from; // learn the initiator's claimed device id
      this.client.watch(from); // so we see the peer go offline
    }
    if (!this.hs || this.hs.isComplete) {
      this.hs = CoreNoiseHandshake.responder(nobleNoisePrimitives, this.staticKeypair);
    }
    this.step('msg1', 'active');
  }

  private looksLikeMsg1(payload: Uint8Array): boolean {
    // Try to read it as msg1 on a throwaway handshake; if it authenticates,
    // it is a genuine re-pair. Cheap and avoids corrupting the live handshake.
    try {
      const probe = CoreNoiseHandshake.responder(nobleNoisePrimitives, this.staticKeypair);
      probe.readMessage(payload);
      return true;
    } catch {
      return false;
    }
  }

  private rearmResponder(from: string, payload: Uint8Array): void {
    this.teardownTransport();
    this.remoteId = from;
    this.hs = CoreNoiseHandshake.responder(nobleNoisePrimitives, this.staticKeypair);
    this.step('msg1', 'done');
    this.hs.readMessage(payload);
    if (this.hs.isMyTurn) this.client.relay(this.remoteId, this.hs.writeMessage());
    if (this.hs.isComplete) this.complete(this.hs);
  }

  private complete(hs: CoreNoiseHandshake): void {
    // Bind the authenticated key to the expected identity (anti-MITM, SPEC §4).
    const authenticatedId = deviceIdFromPublicKey(hs.remoteStaticKey!);
    if (this.opts.role === 'initiator' && authenticatedId !== this.remoteId) {
      this.fail({
        kind: 'identity-mismatch',
        message: `Peer key fingerprints to ${authenticatedId.slice(0, 8)}… but the code expected ${this.remoteId!.slice(0, 8)}…. Do not trust this connection.`,
        retryable: false,
      });
      return;
    }
    this.clearDeadline();
    this.transport = hs.split();
    this.peerPublicKey = new Uint8Array(hs.remoteStaticKey!);
    this.channelBinding = new Uint8Array(hs.handshakeHash);
    this.sessionFingerprint = displayFingerprint(base32Encode(this.channelBinding.subarray(0, 15)));
    this.everPaired = true;
    this.remoteId = authenticatedId;
    this.step('msg2', 'done');
    this.step('verified', 'done');
    this.setState('paired');
    if (!this.settled) {
      this.settled = true;
      this.markPaired();
    }
  }

  private recoverAfterReconnect(): void {
    // The socket came back after a drop; re-pair transparently. Reset so the
    // peer's next online notification is treated as a fresh edge that
    // (re)sends msg1; the BrokerClient re-arms every watch on re-register.
    this.transport = null;
    this.peerOnline = false;
    this.hs = null;
    this.setState('waiting-peer');
    if (this.opts.role === 'initiator') this.client.watch(this.remoteId!);
  }

  private teardownTransport(): void {
    this.transport = null;
  }

  get isPaired(): boolean {
    return this.transport !== null;
  }

  get peerId(): string | null {
    return this.remoteId;
  }

  /** The broker session token, for GET /ice. */
  get sessionToken(): string | null {
    return this.client.sessionToken;
  }

  /** Send an encrypted application message to the peer. */
  send(message: Uint8Array | string): void {
    if (!this.transport) throw new Error('not paired yet');
    const pt = typeof message === 'string' ? new TextEncoder().encode(message) : message;
    this.client.relay(this.remoteId!, this.transport.send.encryptWithAd(new Uint8Array(0), pt));
  }

  close(): void {
    this.clearDeadline();
    this.unsub?.();
    this.transport = null;
    this.setState('closed');
  }
}
