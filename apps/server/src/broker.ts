/**
 * Transport-agnostic rendezvous + signaling broker (SPEC §4, §6-transport).
 *
 * Responsibilities, and nothing more:
 *   - Authenticate a device by proving its public key fingerprints to its ID.
 *   - Route opaque relay blobs between online devices by ID.
 *   - Report peer presence to interested watchers.
 *
 * It is deliberately zero-trust: it never inspects a relay payload, never holds
 * a decryption key, and never mediates the media path (that goes P2P via ICE).
 * Keeping this class transport-agnostic lets the smoke test drive it with
 * in-memory connections — no sockets, no network, fully deterministic.
 */

import { randomBytes } from 'node:crypto';
import {
  parseClientMessage,
  publicKeyMatchesId,
  PROTOCOL_VERSION,
  type ServerMessage,
} from '@tether/protocol';

export interface Connection {
  /** Transient per-connection id (not the device id). */
  readonly id: string;
  send(msg: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

interface ConnState {
  deviceId: string | null;
  /** Raw public key (base64), as registered — reused to mint pair codes. */
  publicKey: string | null;
  watching: Set<string>;
  /** Simple token bucket for relay flood protection. */
  relayTokens: number;
  lastRefill: number;
  /** Session token issued at registration; gates /ice (see validateSession). */
  sessionToken: string | null;
}

interface PairCode {
  deviceId: string;
  publicKey: string;
  expiresAt: number;
  resolves: number;
}

export interface BrokerOptions {
  heartbeatIntervalMs?: number;
  /** Relay messages allowed per second per connection. */
  relayRatePerSec?: number;
  /** How long an issued session token stays valid (ms). */
  sessionTtlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable token source for the session token. */
  randomToken?: () => string;
}

export class Broker {
  private readonly conns = new Map<Connection, ConnState>();
  private readonly byDevice = new Map<string, Connection>();
  /** targetDeviceId -> connections watching its presence. */
  private readonly watchers = new Map<string, Set<Connection>>();

  /** Short human join code -> the responder's pair blob. Deleted on disconnect
   *  or expiry; capped resolves. The broker already holds the id + key from
   *  register, so this exposes nothing it did not already have. */
  private readonly pairCodes = new Map<string, PairCode>();

  /** Session token -> device + expiry. Gates /ice; lifetime-bound to the WS conn. */
  private readonly sessions = new Map<string, { deviceId: string; expiresAt: number }>();

  private readonly heartbeatIntervalMs: number;
  private readonly relayRatePerSec: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;

  constructor(opts: BrokerOptions = {}) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 20_000;
    this.relayRatePerSec = opts.relayRatePerSec ?? 50;
    this.sessionTtlMs = opts.sessionTtlMs ?? 3_600_000;
    this.now = opts.now ?? (() => Date.now());
    this.randomToken = opts.randomToken ?? (() => randomBytes(24).toString('base64url'));
  }

  /**
   * Validate a session token issued at registration. Returns the owning device
   * id, or null if unknown/expired. Used to gate /ice against anonymous TURN use.
   */
  validateSession(token: string): { deviceId: string } | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return { deviceId: s.deviceId };
  }

  /**
   * Mint a short join code for the device that owns `sessionToken`. The code
   * resolves to the same {deviceId, publicKey} the QR carries. Trust still
   * rests on the post-handshake fingerprint compare, not on the code.
   */
  createPairCode(sessionToken: string, ttlMs = 600_000): { code: string; ttlSec: number } | null {
    const session = this.validateSession(sessionToken);
    if (!session) return null;
    const state = [...this.conns.values()].find((c) => c.sessionToken === sessionToken);
    if (!state?.publicKey || !state.deviceId) return null;
    this.sweepPairCodes();
    // Drop any prior code for this device so only the latest is live.
    for (const [c, pc] of this.pairCodes) if (pc.deviceId === state.deviceId) this.pairCodes.delete(c);
    const code = this.makeJoinCode();
    this.pairCodes.set(code, {
      deviceId: state.deviceId,
      publicKey: state.publicKey,
      expiresAt: this.now() + ttlMs,
      resolves: 0,
    });
    return { code, ttlSec: Math.round(ttlMs / 1000) };
  }

  /** Resolve a join code to a pair blob, or null. Capped at 3 resolves. */
  resolvePairCode(code: string): { id: string; key: string } | null {
    const pc = this.pairCodes.get(code.toUpperCase());
    if (!pc) return null;
    if (this.now() >= pc.expiresAt || pc.resolves >= 3) {
      this.pairCodes.delete(code.toUpperCase());
      return null;
    }
    pc.resolves++;
    return { id: pc.deviceId, key: pc.publicKey };
  }

  private sweepPairCodes(): void {
    const t = this.now();
    for (const [code, pc] of this.pairCodes) if (t >= pc.expiresAt) this.pairCodes.delete(code);
  }

  private makeJoinCode(): string {
    // 30-symbol alphabet, no 0/O/1/I/L — ~30^6 ≈ 7e8 space, TTL + resolve cap
    // + per-IP lookup limit keep it unguessable in practice.
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = '';
      const bytes = randomBytes(6);
      for (let i = 0; i < 6; i++) code += A[bytes[i]! % A.length];
    } while (this.pairCodes.has(code));
    return code;
  }

  /** Number of currently registered devices — for /health and tests. */
  get onlineCount(): number {
    return this.byDevice.size;
  }

  isOnline(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  onConnect(conn: Connection): void {
    this.conns.set(conn, {
      deviceId: null,
      publicKey: null,
      watching: new Set(),
      relayTokens: this.relayRatePerSec,
      lastRefill: this.now(),
      sessionToken: null,
    });
  }

  onMessage(conn: Connection, raw: unknown): void {
    const state = this.conns.get(conn);
    if (!state) return; // message after disconnect

    const msg = parseClientMessage(raw);
    if (!msg) {
      conn.send({ t: 'error', code: 'bad-message', message: 'unparseable message' });
      return;
    }

    switch (msg.t) {
      case 'ping':
        conn.send({ t: 'pong' });
        return;

      case 'register': {
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          conn.send({
            t: 'error',
            code: 'unsupported-version',
            message: `server speaks protocol v${PROTOCOL_VERSION}`,
          });
          return;
        }
        let key: Uint8Array;
        try {
          key = new Uint8Array(Buffer.from(msg.publicKey, 'base64'));
        } catch {
          conn.send({ t: 'error', code: 'bad-message', message: 'publicKey not base64' });
          return;
        }
        if (!publicKeyMatchesId(key, msg.deviceId)) {
          conn.send({
            t: 'error',
            code: 'id-key-mismatch',
            message: 'deviceId is not the fingerprint of publicKey',
          });
          return;
        }
        // Displace any prior connection for this device id (and its token).
        const prior = this.byDevice.get(msg.deviceId);
        if (prior && prior !== conn) {
          const priorState = this.conns.get(prior);
          if (priorState?.sessionToken) this.sessions.delete(priorState.sessionToken);
          prior.send({ t: 'error', code: 'not-registered', message: 'replaced by a new session' });
          prior.close(4001, 'replaced');
        }
        state.deviceId = msg.deviceId;
        state.publicKey = msg.publicKey;
        this.byDevice.set(msg.deviceId, conn);

        const sessionToken = this.randomToken();
        state.sessionToken = sessionToken;
        this.sessions.set(sessionToken, {
          deviceId: msg.deviceId,
          expiresAt: this.now() + this.sessionTtlMs,
        });
        conn.send({
          t: 'registered',
          sessionToken,
          heartbeatIntervalMs: this.heartbeatIntervalMs,
        });
        this.notifyWatchers(msg.deviceId, true);
        return;
      }

      case 'watch': {
        if (!state.deviceId) {
          conn.send({ t: 'error', code: 'not-registered', message: 'register before watch' });
          return;
        }
        state.watching.add(msg.deviceId);
        let set = this.watchers.get(msg.deviceId);
        if (!set) {
          set = new Set();
          this.watchers.set(msg.deviceId, set);
        }
        set.add(conn);
        conn.send({ t: 'peer-status', deviceId: msg.deviceId, online: this.isOnline(msg.deviceId) });
        return;
      }

      case 'relay': {
        if (!state.deviceId) {
          conn.send({ t: 'error', code: 'not-registered', message: 'register before relay' });
          return;
        }
        if (!this.consumeRelayToken(state)) {
          conn.send({ t: 'error', code: 'rate-limited', message: 'relay rate exceeded' });
          return;
        }
        const target = this.byDevice.get(msg.to);
        if (!target) {
          conn.send({ t: 'error', code: 'peer-offline', message: `${msg.to} is not online` });
          return;
        }
        target.send({ t: 'deliver', from: state.deviceId, payload: msg.payload });
        return;
      }
    }
  }

  onDisconnect(conn: Connection): void {
    const state = this.conns.get(conn);
    if (!state) return;
    this.conns.delete(conn);

    // A session token is only valid while its connection is live.
    if (state.sessionToken) this.sessions.delete(state.sessionToken);
    // Pair codes live only as long as the host's connection.
    if (state.deviceId) {
      for (const [code, pc] of this.pairCodes) {
        if (pc.deviceId === state.deviceId) this.pairCodes.delete(code);
      }
    }

    for (const target of state.watching) {
      this.watchers.get(target)?.delete(conn);
    }
    // Only clear the device mapping if THIS connection still owns it — a
    // displaced older connection must not delete the newer one's registration.
    if (state.deviceId && this.byDevice.get(state.deviceId) === conn) {
      this.byDevice.delete(state.deviceId);
      this.notifyWatchers(state.deviceId, false);
    }
  }

  private notifyWatchers(deviceId: string, online: boolean): void {
    const set = this.watchers.get(deviceId);
    if (!set) return;
    for (const conn of set) {
      conn.send({ t: 'peer-status', deviceId, online });
    }
  }

  private consumeRelayToken(state: ConnState): boolean {
    const t = this.now();
    const elapsed = (t - state.lastRefill) / 1000;
    if (elapsed > 0) {
      state.relayTokens = Math.min(
        this.relayRatePerSec,
        state.relayTokens + elapsed * this.relayRatePerSec,
      );
      state.lastRefill = t;
    }
    if (state.relayTokens < 1) return false;
    state.relayTokens -= 1;
    return true;
  }
}
