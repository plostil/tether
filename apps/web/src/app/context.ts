/** Wires the app together: identity, broker transport, store, router, session. */

export type { ClientSpec, Transport } from './transport.ts';

import type { StaticKeypair } from '@tether/protocol/browser';
import { loadOrCreateIdentity } from '../identity-store.ts';
import { deviceIdFromPublicKey } from '../crypto-noble.ts';
import type { IBrokerClient } from '../broker-client.ts';
import { chooseTransport, clientFor, type ClientSpec, type Transport } from './transport.ts';
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
  /** True when there is no rendezvous server: the demo runs, real pairing cannot. */
  standalone: boolean;
  transport: Transport;
  newClient(spec: ClientSpec): IBrokerClient;
  store: Store<AppState>;
  router: Router;
  client: IBrokerClient;
  session: SessionController;
  settings: Settings;
  saveSettings(patch: Partial<Settings>): void;
  deviceName(): string;
}

interface RuntimeConfig {
  demo: boolean;
  turn: boolean;
}

/** `GET config` from the broker that served the page; null when nothing answers
 *  (a static host has no broker behind it). Relative, so it resolves under a
 *  sub-path such as `/tether/app/`. */
async function fetchRuntimeConfig(): Promise<RuntimeConfig | null> {
  try {
    const res = await fetch('config');
    if (!res.ok) return null;
    const cfg = (await res.json()) as Partial<RuntimeConfig>;
    return { demo: !!cfg.demo, turn: !!cfg.turn };
  } catch {
    return null;
  }
}

export async function createContext(): Promise<AppContext> {
  const identity = loadOrCreateIdentity();
  const myId = deviceIdFromPublicKey(identity.publicKey);
  let settings = loadSettings();
  applyTheme(settings.theme);

  const store = createStore<AppState>(initialState);
  const router = createRouter();

  // Runtime config from the server (demo flag, TURN availability). No answer
  // means no server: fall back to the in-tab loopback transport.
  const forced = typeof __STANDALONE__ !== 'undefined' && __STANDALONE__;
  const cfg = forced ? null : await fetchRuntimeConfig();
  const transport = chooseTransport({ brokerUrl: settings.brokerUrl, backend: cfg !== null, forced });
  const standalone = transport.kind === 'loopback';
  const serverUrl = transport.kind === 'ws' ? transport.serverUrl : 'loopback';
  store.set({ config: { demo: !!cfg?.demo, turn: !!cfg?.turn, standalone } });

  const deviceName = () => settings.deviceName || defaultDeviceName();
  const newClient = (spec: ClientSpec) => clientFor(transport, spec);

  const client = newClient({ staticKeypair: identity, deviceId: myId, capabilities: browserCapabilities(null) });
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
    standalone,
    transport,
    newClient,
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
