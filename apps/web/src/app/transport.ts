/**
 * Which broker transport the page runs on, and a factory for clients on it.
 * Kept free of DOM imports so the Node unit tests can exercise it.
 */

import type { DeviceCapabilities, StaticKeypair } from '@tether/protocol/browser';
import { BrokerClient, type IBrokerClient } from '../broker-client.ts';
import { LoopbackHub, LoopbackBrokerClient } from '../loopback.ts';

export interface ClientSpec {
  staticKeypair: StaticKeypair;
  deviceId: string;
  capabilities: DeviceCapabilities;
  log?: (line: string) => void;
}

/**
 * Where broker messages go. `ws` is the real rendezvous server; `loopback` is
 * the in-tab hub used when the page is served with no backend at all (the
 * hosted copy on GitHub Pages, or `dist/` opened from any static file server).
 * Every client the page creates — its own and the demo's virtual device — goes
 * through `newClient`, so the two always share one transport.
 */
export type Transport = { kind: 'ws'; serverUrl: string } | { kind: 'loopback'; hub: LoopbackHub };

export function chooseTransport(opts: { brokerUrl: string; backend: boolean; forced: boolean }): Transport {
  if (opts.brokerUrl) return { kind: 'ws', serverUrl: opts.brokerUrl };
  if (opts.forced || !opts.backend) return { kind: 'loopback', hub: new LoopbackHub() };
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  return { kind: 'ws', serverUrl: `${wsProto}://${location.host}/signal` };
}

export function clientFor(transport: Transport, spec: ClientSpec): IBrokerClient {
  if (transport.kind === 'loopback') return new LoopbackBrokerClient(transport.hub, spec.deviceId);
  return new BrokerClient({
    serverUrl: transport.serverUrl,
    staticKeypair: spec.staticKeypair,
    deviceId: spec.deviceId,
    capabilities: spec.capabilities,
    reconnect: true,
    log: spec.log,
  });
}
