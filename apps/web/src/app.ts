/**
 * App entry: build the context, render the persistent nav, and mount the
 * screen for the current hash route. Screens own their own store
 * subscriptions and clean up when the route changes. The active link lives in
 * the SessionController (in the context), so it survives navigation.
 */

import './ui/tokens.css';
import './ui/base.css';
import './ui/components.css';

import { h, mount } from './ui/dom.ts';
import { Nav } from './ui/nav.ts';
import { StatusPill } from './ui/status-pill.ts';
import { Banner } from './ui/toast.ts';
import { createContext, type AppContext } from './app/context.ts';
import type { Route } from './app/router.ts';
import { StartScreen } from './screens/start.ts';
import { PairScreen } from './screens/pair.ts';
import { DevicesScreen } from './screens/devices.ts';
import { LiveScreen } from './screens/live.ts';
import { SettingsScreen } from './screens/settings.ts';
import { IphoneSetupScreen } from './screens/iphone-setup.ts';
import { IphoneLiveScreen } from './screens/iphone-live.ts';
import { KitchenSink } from './screens/kitchen-sink.ts';

export type Screen = (root: HTMLElement, ctx: AppContext, route: Route) => () => void;

const routes: Array<{ prefix: string; screen: Screen }> = [
  { prefix: '/pair', screen: PairScreen },
  { prefix: '/devices', screen: DevicesScreen },
  { prefix: '/live', screen: LiveScreen },
  { prefix: '/settings', screen: SettingsScreen },
  { prefix: '/iphone/setup', screen: IphoneSetupScreen },
  { prefix: '/iphone/live', screen: IphoneLiveScreen },
  { prefix: '/kitchen-sink', screen: KitchenSink },
  { prefix: '/', screen: StartScreen },
];

function pick(path: string): Screen {
  // longest-prefix match, '/iphone/live' before '/iphone', '/' last.
  const sorted = [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
  return (sorted.find((r) => path === r.prefix || path.startsWith(r.prefix === '/' ? '/' : r.prefix + '/') || path === r.prefix) ?? routes[routes.length - 1]!).screen;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  const ctx = await createContext();

  const NAV_LINKS = [
    { href: '#/', label: 'Start' },
    { href: '#/devices', label: 'Devices' },
    { href: '#/settings', label: 'Settings' },
  ];

  const view = h('main', { id: 'view' });
  const offlineHost = h('div', {});

  const linkPill = StatusPill('idle', 'nav-session-pill');
  const renderNav = () => {
    const s = ctx.store.get();
    if (s.link.state === 'paired') linkPill.set('secure', 'session live');
    else if (s.link.state === 'degraded') linkPill.set('warn', 'reconnecting');
    else if (s.link.state === 'failed') linkPill.set('fault', 'link failed');
    else if (s.link.state !== 'idle') linkPill.set('info', s.link.state);
    else linkPill.set('neutral', 'no session');
    const nav = Nav({
      routes: NAV_LINKS,
      active: ctx.router.current().path,
      right: ctx.session.active ? [linkPill.el] : [],
    });
    return nav;
  };

  let navEl = renderNav();
  mount(app, navEl, offlineHost, view);

  // Offline banner reacts to store.online.
  ctx.store.subscribe(() => {
    const online = ctx.store.get().online;
    offlineHost.replaceChildren(
      online ? '' : Banner({ tone: 'warn', message: 'You are offline. Reconnecting when the network returns.' }),
    );
    // refresh nav (active link / session pill)
    const next = renderNav();
    navEl.replaceWith(next);
    navEl = next;
  });

  let cleanup: (() => void) | null = null;
  const render = () => {
    cleanup?.();
    const route = ctx.router.current();
    const screen = pick(route.path);
    view.replaceChildren();
    cleanup = screen(view, ctx, route);
    const next = renderNav();
    navEl.replaceWith(next);
    navEl = next;
  };
  ctx.router.onChange(render);
  render();

  // Auto-start demo when the server was launched with TETHER_DEMO=1.
  if (ctx.store.get().config.demo && ctx.router.current().path === '/') {
    ctx.router.navigate('/pair/demo');
  }
}

void boot();
