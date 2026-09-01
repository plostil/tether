import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InputEvent } from '@tether/protocol';
import { IosController } from '../src/ios-control/controller.ts';
import type { WdaClient } from '../src/ios-control/wda-client.ts';
import { iosControlWsHandler } from '../src/ios-control/channel.ts';
import type { Broker } from '../src/broker.ts';
import type { WsConnection } from '../src/ws.ts';

// ---- gesture synthesis: InputEvent -> WDA calls -----------------------------

class FakeWda {
  taps: Array<[number, number]> = [];
  swipes: Array<[number, number, number, number, number]> = [];
  texts: string[] = [];
  homes = 0;
  reset(): void {}
  async ensureSession(): Promise<string> {
    return 'S';
  }
  async windowSizePoints(): Promise<{ width: number; height: number }> {
    return { width: 400, height: 800 };
  }
  async tap(x: number, y: number): Promise<void> {
    this.taps.push([x, y]);
  }
  async swipe(x1: number, y1: number, x2: number, y2: number, d: number): Promise<void> {
    this.swipes.push([x1, y1, x2, y2, d]);
  }
  async typeText(t: string): Promise<void> {
    this.texts.push(t);
  }
  async pressHome(): Promise<void> {
    this.homes++;
  }
  async screenshotBase64(): Promise<string> {
    return 'PNG';
  }
}

async function connectedController(now: () => number): Promise<{ c: IosController; w: FakeWda }> {
  const w = new FakeWda();
  const c = new IosController({ client: w as unknown as WdaClient, now });
  await c.connect('http://phone:8100');
  return { c, w };
}

test('a same-point press+release becomes a tap at scaled coords', async () => {
  const { c, w } = await connectedController(() => 1000);
  c.dispatch({ i: 'pdown', x: 0.5, y: 0.5, b: 0 });
  c.dispatch({ i: 'pup', x: 0.5, y: 0.5, b: 0 });
  assert.deepEqual(w.taps, [[200, 400]]);
  assert.equal(w.swipes.length, 0);
});

test('a displaced press+release becomes a swipe with the held duration', async () => {
  let clock = 1000;
  const { c, w } = await connectedController(() => clock);
  c.dispatch({ i: 'pdown', x: 0.1, y: 0.1, b: 0 });
  clock += 200;
  c.dispatch({ i: 'pup', x: 0.9, y: 0.9, b: 0 });
  assert.equal(w.taps.length, 0);
  assert.deepEqual(w.swipes, [[40, 80, 360, 720, 200]]);
});

test('wheel becomes a centered vertical swipe', async () => {
  const { c, w } = await connectedController(() => 0);
  c.dispatch({ i: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
  assert.deepEqual(w.swipes, [[200, 400, 200, 200, 120]]);
});

test('text types and nav:home presses Home; key and other nav are ignored', async () => {
  const { c, w } = await connectedController(() => 0);
  c.dispatch({ i: 'text', text: 'hey' });
  c.dispatch({ i: 'nav', action: 'home' });
  c.dispatch({ i: 'nav', action: 'back' });
  c.dispatch({ i: 'key', code: 'KeyA', down: true });
  assert.deepEqual(w.texts, ['hey']);
  assert.equal(w.homes, 1);
});

test('dispatch is inert before connect', () => {
  const c = new IosController({ client: new FakeWda() as unknown as WdaClient });
  c.dispatch({ i: 'pdown', x: 0.5, y: 0.5, b: 0 });
  c.dispatch({ i: 'pup', x: 0.5, y: 0.5, b: 0 });
  // No throw, no session — isReady() is false until connect() caches the size.
  assert.equal(c.isReady(), false);
});

// ---- /ios-control channel: localhost + auth + opt-in ------------------------

class FakeConn {
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  sendJson(m: unknown): void {
    this.sent.push(m);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
}

function fakeReq(remoteAddress: string | undefined) {
  return { socket: { remoteAddress } } as unknown as import('node:http').IncomingMessage;
}

function stubBroker(validTokens: string[]): Broker {
  return {
    validateSession: (t: string) => (validTokens.includes(t) ? { deviceId: 'dev' } : null),
  } as unknown as Broker;
}

class RecordingController {
  connected: string[] = [];
  events: InputEvent[] = [];
  private listener: ((s: string, m?: string) => void) | null = null;
  setStatusListener(fn: ((s: string, m?: string) => void) | null): void {
    this.listener = fn;
  }
  async connect(url: string): Promise<void> {
    this.connected.push(url);
    this.listener?.('ready');
  }
  async screenshot(): Promise<string | null> {
    return null;
  }
  dispatch(ev: InputEvent): void {
    this.events.push(ev);
  }
  close(): void {}
}

function wire(broker: Broker, ctrl: RecordingController, remote: string, defaultUrl: string | null = null) {
  const conn = new FakeConn();
  const h = iosControlWsHandler(broker, ctrl as unknown as IosController, defaultUrl)(
    conn as unknown as WsConnection,
    fakeReq(remote),
  );
  return { conn, h };
}

test('/ios-control rejects a non-loopback peer', () => {
  const ctrl = new RecordingController();
  const { conn, h } = wire(stubBroker(['tok']), ctrl, '192.168.1.9');
  h.onText(JSON.stringify({ t: 'ios-hello', sessionToken: 'tok', wdaUrl: 'http://phone:8100' }));
  assert.equal(conn.closed?.code, 1008);
  assert.equal(ctrl.connected.length, 0);
});

test('/ios-control rejects a bad session token', () => {
  const ctrl = new RecordingController();
  const { conn, h } = wire(stubBroker(['good']), ctrl, '127.0.0.1');
  h.onText(JSON.stringify({ t: 'ios-hello', sessionToken: 'bad', wdaUrl: 'http://phone:8100' }));
  assert.equal(conn.closed?.code, 1008);
  assert.equal(ctrl.connected.length, 0);
});

test('/ios-control connects on hello and gates control on the opt-in toggle', () => {
  const ctrl = new RecordingController();
  const { conn, h } = wire(stubBroker(['tok']), ctrl, '::1');
  h.onText(JSON.stringify({ t: 'ios-hello', sessionToken: 'tok', wdaUrl: 'http://phone:8100' }));
  assert.deepEqual(ctrl.connected, ['http://phone:8100']);
  assert.ok(conn.sent.some((m) => (m as { status?: string }).status === 'ready'));

  // Off by default: input events are dropped.
  h.onText(JSON.stringify({ i: 'pmove', x: 0.5, y: 0.5 }));
  assert.equal(ctrl.events.length, 0);

  // Opt in, then the same event flows.
  h.onText(JSON.stringify({ t: 'ios-enable', enabled: true }));
  h.onText(JSON.stringify({ i: 'pmove', x: 0.5, y: 0.5 }));
  assert.deepEqual(ctrl.events, [{ i: 'pmove', x: 0.5, y: 0.5 }]);

  // Toggle back off.
  h.onText(JSON.stringify({ t: 'ios-enable', enabled: false }));
  h.onText(JSON.stringify({ i: 'pmove', x: 0.1, y: 0.1 }));
  assert.equal(ctrl.events.length, 1);
  h.onClose();
});

test('/ios-control reports unreachable when no WDA URL is configured', () => {
  const ctrl = new RecordingController();
  const { conn, h } = wire(stubBroker(['tok']), ctrl, '127.0.0.1', null);
  h.onText(JSON.stringify({ t: 'ios-hello', sessionToken: 'tok' }));
  assert.equal(ctrl.connected.length, 0);
  assert.ok(
    conn.sent.some(
      (m) => (m as { status?: string; message?: string }).status === 'unreachable',
    ),
  );
});
