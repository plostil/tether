/**
 * The in-page virtual device — the whole point of demo mode.
 *
 * It is a SECOND, independent Tether device living in the same tab: its own
 * identity (a different localStorage key → a different device id, so the broker
 * does not treat it as a duplicate of the page's own device), its own
 * WebSocket to the same broker, and a real Noise_IK responder. The page pairs
 * with it as the initiator, running the real handshake over the real relay; the
 * virtual device then shares a synthetic canvas over a real WebRTC connection.
 * Nothing here is mocked — swap the canvas for getDisplayMedia and it is the
 * two-machine flow.
 */

import { loadOrCreateIdentity, DEMO_IDENTITY_KEY } from '../identity-store.ts';
import { deviceIdFromPublicKey } from '../crypto-noble.ts';
import { BrokerClient } from '../broker-client.ts';
import { SecureLink, type LinkEvent } from '../secure-link.ts';
import { ScreenShareSource, fetchIceServers } from '../rtc.ts';
import { decodeControl, encodeControl, type ControlMessage } from '../control.ts';
import { VIRTUAL_DEVICE_CAPS } from '../capabilities.ts';
import { toB64 } from '../b64.ts';
import type { PairBlob } from '../pairing.ts';

export const DEMO_DEVICE_NAME = 'Demo PC (virtual)';

export class VirtualDevice {
  readonly deviceId: string;
  readonly pairBlob: PairBlob;
  private readonly client: BrokerClient;
  private readonly link: SecureLink;
  private readonly desktop: { start(): void; stop(): void; stream(fps?: number): MediaStream; pointer(x: number, y: number): void; click(x: number, y: number): void; type(t: string): void };
  private source: ScreenShareSource | null = null;
  private readonly serverUrl: string;

  constructor(
    serverUrl: string,
    desktop: VirtualDevice['desktop'],
    onEvent?: (e: LinkEvent) => void,
  ) {
    this.serverUrl = serverUrl;
    this.desktop = desktop;
    const identity = loadOrCreateIdentity(DEMO_IDENTITY_KEY);
    this.deviceId = deviceIdFromPublicKey(identity.publicKey);
    this.pairBlob = { id: this.deviceId, key: toB64(identity.publicKey) };

    this.client = new BrokerClient({
      serverUrl,
      staticKeypair: identity,
      deviceId: this.deviceId,
      capabilities: VIRTUAL_DEVICE_CAPS,
      reconnect: true,
      log: (l) => console.debug('[virtual]', l),
    });
    this.link = new SecureLink(this.client, identity, {
      role: 'responder',
      onEvent: (e) => {
        if (e.t === 'message') void this.onControl(decodeControl(e.plaintext));
        onEvent?.(e);
      },
    });
  }

  async start(): Promise<void> {
    this.desktop.start();
    await this.client.connect();
    void this.link.pair();
  }

  private send(m: ControlMessage): void {
    try {
      this.link.send(encodeControl(m));
    } catch {
      /* not paired yet */
    }
  }

  private async onControl(msg: ControlMessage | null): Promise<void> {
    if (!msg) return;
    switch (msg.t) {
      case 'hello':
        this.send({ t: 'hello', name: DEMO_DEVICE_NAME, capabilities: VIRTUAL_DEVICE_CAPS, app: 'virtual' });
        return;
      case 'view-request':
        await this.startShare();
        return;
      case 'input':
        if (msg.kind === 'pointer' && msg.x != null && msg.y != null) this.desktop.pointer(msg.x, msg.y);
        else if (msg.kind === 'tap' && msg.x != null && msg.y != null) this.desktop.click(msg.x, msg.y);
        else if (msg.kind === 'keys' && msg.text) this.desktop.type(msg.text);
        return;
      case 'session-answer':
      case 'ice-candidate':
      case 'session-close':
        await this.source?.handle(msg);
        return;
    }
  }

  private async startShare(): Promise<void> {
    if (this.source) return;
    const src = new ScreenShareSource(
      (m) => this.send(m),
      () => {
        this.source = null;
      },
    );
    await src.start(await fetchIceServers(this.link.sessionToken), async () => this.desktop.stream());
    this.source = src;
  }

  stop(): void {
    this.source?.stop('demo ended');
    this.link.close();
    this.client.close();
    this.desktop.stop();
  }
}
