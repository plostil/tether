/**
 * In-memory broker for the standalone (server-less) demo.
 *
 * The hosted demo has no backend: the page and the in-page virtual device pair
 * over this hub instead of a WebSocket to the real broker. It implements the
 * same IBrokerClient surface — register, watch, relay, presence — so the real
 * SecureLink, Noise handshake, and WebRTC path run unchanged; only the message
 * transport is a shared object in the same tab rather than a socket. This is
 * what makes the demo publishable as a single static page.
 */

import type { BrokerEvent, BrokerState, IBrokerClient, LinkFault } from './broker-client.ts';

export class LoopbackHub {
  private readonly clients = new Map<string, LoopbackBrokerClient>();
  private readonly watches = new Map<string, Set<LoopbackBrokerClient>>();

  register(client: LoopbackBrokerClient): void {
    this.clients.set(client.deviceId, client);
    const set = this.watches.get(client.deviceId);
    if (set) for (const w of set) w.emitEvent({ t: 'peer-status', deviceId: client.deviceId, online: true });
  }

  unregister(client: LoopbackBrokerClient): void {
    if (this.clients.get(client.deviceId) === client) this.clients.delete(client.deviceId);
    const set = this.watches.get(client.deviceId);
    if (set) for (const w of set) w.emitEvent({ t: 'peer-status', deviceId: client.deviceId, online: false });
  }

  watch(watcher: LoopbackBrokerClient, deviceId: string): void {
    let set = this.watches.get(deviceId);
    if (!set) this.watches.set(deviceId, (set = new Set()));
    set.add(watcher);
    watcher.emitEvent({ t: 'peer-status', deviceId, online: this.clients.has(deviceId) });
  }

  unwatch(watcher: LoopbackBrokerClient, deviceId: string): void {
    this.watches.get(deviceId)?.delete(watcher);
  }

  route(from: string, to: string, payload: Uint8Array): void {
    const target = this.clients.get(to);
    if (target) queueMicrotask(() => target.emitEvent({ t: 'deliver', from, payload }));
  }
}

export class LoopbackBrokerClient implements IBrokerClient {
  readonly deviceId: string;
  state: BrokerState = 'idle';
  sessionToken: string | null = 'loopback';
  fault: LinkFault | null = null;
  private readonly handlers = new Set<(e: BrokerEvent) => void>();

  constructor(
    private readonly hub: LoopbackHub,
    deviceId: string,
  ) {
    this.deviceId = deviceId;
  }

  on(handler: (e: BrokerEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emitEvent(e: BrokerEvent): void {
    for (const h of this.handlers) h(e);
  }

  get isRegistered(): boolean {
    return this.state === 'registered';
  }

  connect(): Promise<void> {
    this.state = 'registered';
    this.hub.register(this);
    this.emitEvent({ t: 'state', state: 'registered' });
    return Promise.resolve();
  }

  watch(deviceId: string): void {
    this.hub.watch(this, deviceId);
  }

  unwatch(deviceId: string): void {
    this.hub.unwatch(this, deviceId);
  }

  relay(to: string, payload: Uint8Array): void {
    this.hub.route(this.deviceId, to, payload);
  }

  close(): void {
    this.hub.unregister(this);
    this.state = 'closed';
    this.emitEvent({ t: 'state', state: 'closed' });
  }
}
