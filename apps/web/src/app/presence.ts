/** Watches known peers over the shared page client and mirrors online/offline
 *  into the store, so the Devices screen can show live presence dots. */

import type { BrokerClient } from '../broker-client.ts';
import { listKnownPeers } from '../known-peers.ts';
import type { Store } from './store.ts';
import type { AppState } from './state.ts';

export function startPresence(client: BrokerClient, store: Store<AppState>): () => void {
  const watched = new Set<string>();
  const refresh = () => {
    for (const peer of listKnownPeers()) {
      if (!watched.has(peer.id)) {
        watched.add(peer.id);
        if (client.isRegistered) client.watch(peer.id);
      }
    }
  };
  const off = client.on((e) => {
    if (e.t === 'peer-status') {
      store.set((s) => ({ presence: { ...s.presence, [e.deviceId]: e.online } }));
    } else if (e.t === 'state' && e.state === 'registered') {
      // Re-arm watches after every (re)registration.
      for (const id of watched) client.watch(id);
    }
  });
  refresh();
  return () => {
    off();
    watched.clear();
  };
}
