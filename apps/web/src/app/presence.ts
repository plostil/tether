/** Watches known peers over the shared page client and mirrors online/offline
 *  into the store, so the Devices screen can show live presence dots. */

import type { BrokerClient } from '../broker-client.ts';
import { listKnownPeers } from '../known-peers.ts';
import { toast } from '../ui/toast.ts';
import type { Store } from './store.ts';
import type { AppState } from './state.ts';

export function startPresence(client: BrokerClient, store: Store<AppState>): () => void {
  const watched = new Set<string>();
  const lastSeen = new Map<string, boolean>();
  const labelOf = (id: string) => listKnownPeers().find((p) => p.id === id)?.label ?? 'A device';
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
      // Toast only on a real transition (not the initial snapshot), and only
      // when we are not already in a live session with that peer.
      const prev = lastSeen.get(e.deviceId);
      if (prev !== undefined && prev !== e.online && store.get().link.peer?.id !== e.deviceId) {
        toast(e.online ? 'secure' : 'warn', `${labelOf(e.deviceId)} is ${e.online ? 'online' : 'offline'}`);
      }
      lastSeen.set(e.deviceId, e.online);
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
