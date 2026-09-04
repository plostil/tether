/** Wires the app together: identity, broker client, store, router, session. */

import type { StaticKeypair } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from '../identity-store.ts';
import { deviceIdFromPublicKey } from '../crypto-noble.ts';
import { BrokerClient } from '../broker-client.ts';
import { browserCapabilities } from '../capabilities.ts';
import { createStore, type Store } from './store.ts';
import { createRouter, type Router } from './router.ts';
import { initialState, type AppState } from './state.ts';
import { SessionController } from './session.ts';
import { startPresence } from './presence.ts';
import { loadSettings, saveSettings, applyTheme, defaultDeviceName, type Settings } from './settings.ts';

export interface AppContext {
  identity: StaticKeypair;
  myId: string;
  serverUrl: string;
  store: Store<AppState>;
  router: Router;
  client: BrokerClient;
  session: SessionController;
  settings: Settings;
  saveSettings(patch: Partial<Settings>): void;
  deviceName(): string;
}

export async function createContext(): Promise<AppContext> {
  const identity = loadOrCreateIdentity();
  const myId = deviceIdFromPublicKey(identity.publicKey);
  let settings = loadSettings();
  applyTheme(settings.theme);

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const serverUrl = settings.brokerUrl || `${wsProto}://${location.host}/signal`;

  const store = createStore<AppState>(initialState);
  const router = createRouter();

  // Runtime config from the server (demo flag, TURN availability).
  try {
    const cfg = (await (await fetch('/config')).json()) as { demo: boolean; turn: boolean };
    store.set({ config: { demo: !!cfg.demo, turn: !!cfg.turn } });
  } catch {
    /* defaults */
  }

  const deviceName = () => settings.deviceName || defaultDeviceName();

  const client = new BrokerClient({
    serverUrl,
    staticKeypair: identity,
    deviceId: myId,
    capabilities: browserCapabilities(null),
    reconnect: true,
  });
  client.on((e) => {
    if (e.t === 'state') {
      store.set({ online: e.state !== 'offline' && e.state !== 'reconnecting' });
    }
  });

  const session = new SessionController(client, identity, store, deviceName);
  startPresence(client, store);

  // navigator online/offline banner
  window.addEventListener('offline', () => store.set({ online: false }));
  window.addEventListener('online', () => store.set({ online: true }));

  const ctx: AppContext = {
    identity,
    myId,
    serverUrl,
    store,
    router,
    client,
    session,
    settings,
    saveSettings(patch) {
      settings = { ...settings, ...patch };
      saveSettings(settings);
      ctx.settings = settings;
      if (patch.theme) applyTheme(patch.theme);
    },
    deviceName,
  };

  // Register the page identity so presence + host/join work. Non-fatal on fail.
  client.connect().catch(() => {});
  return ctx;
}
