import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { eventToLine, Injector, type InjectEvent } from '../src/inject/injector.ts';
import { injectWsHandler } from '../src/inject/channel.ts';
import type { Broker } from '../src/broker.ts';
import type { WsConnection } from '../src/ws.ts';

// ---- eventToLine: exact wire lines ------------------------------------------

test('eventToLine maps each event to the SendInputHost line protocol', () => {
  assert.equal(eventToLine({ i: 'pmove', x: 0, y: 1 }), 'm 0 65535');
  assert.equal(eventToLine({ i: 'pmove', x: 0.5, y: 0.5 }), 'm 32768 32768');
  assert.equal(eventToLine({ i: 'pdown', x: 0, y: 0, b: 0 }), 'd 0');
  assert.equal(eventToLine({ i: 'pup', x: 0, y: 0, b: 2 }), 'u 2');
  // WheelEvent deltaY>0 (scroll down) must become negative Win32 WHEEL.
  assert.equal(eventToLine({ i: 'wheel', x: 0, y: 0, dx: 0, dy: 120 }), 'w 0 -120');
  assert.equal(eventToLine({ i: 'key', sc: 0x1e, ext: false, down: true }), 'k 30 1 0');
  assert.equal(eventToLine({ i: 'key', sc: 0x4b, ext: true, down: false }), 'k 75 0 1');
  assert.equal(eventToLine({ i: 'text', text: 'Hi' }), `t ${Buffer.from('Hi').toString('base64')}`);
});

// ---- Injector: persistent child, exact stdin ------------------------------

class FakeChild extends EventEmitter {
  writes: string[] = [];
  killed = false;
  stdin = {
    writable: true,
    write: (s: string) => {
      this.writes.push(s);
      return true;
    },
    end: () => {},
  };
  kill() {
    this.killed = true;
  }
}

test('Injector spawns once (lazily) and streams stdin lines', () => {
  let spawnCount = 0;
  const child = new FakeChild();
  const fakeSpawn = ((..._args: unknown[]) => {
    spawnCount++;
    return child;
  }) as unknown as typeof import('node:child_process').spawn;

  const inj = new Injector({ spawn: fakeSpawn });
  assert.equal(spawnCount, 0, 'no spawn before first event');

  inj.dispatch({ i: 'pmove', x: 0.25, y: 0.75 });
  inj.dispatch({ i: 'pdown', x: 0.25, y: 0.75, b: 0 });
  inj.dispatch({ i: 'pup', x: 0.25, y: 0.75, b: 0 });

  assert.equal(spawnCount, 1, 'persistent: spawned exactly once');
  assert.deepEqual(child.writes, ['m 16384 49151\n', 'd 0\n', 'u 0\n']);

  inj.close();
  assert.equal(child.killed, true);
});

test('Injector drops events after close()', () => {
  const child = new FakeChild();
  const inj = new Injector({
    spawn: (() => child) as unknown as typeof import('node:child_process').spawn,
  });
  inj.close();
  inj.dispatch({ i: 'pmove', x: 0.5, y: 0.5 });
  assert.deepEqual(child.writes, []);
});

// ---- /inject channel: localhost + auth + opt-in -----------------------------

class FakeConn {
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  sendJson(m: unknown) {
    this.sent.push(m);
  }
  close(code: number, reason: string) {
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

class RecordingInjector extends Injector {
  events: InjectEvent[] = [];
  constructor() {
    super({ spawn: (() => new FakeChild()) as unknown as typeof import('node:child_process').spawn });
  }
  override dispatch(ev: InjectEvent) {
    this.events.push(ev);
  }
}

test('/inject rejects a non-loopback peer', () => {
  const inj = new RecordingInjector();
  const conn = new FakeConn();
  const h = injectWsHandler(stubBroker(['tok']), inj)(conn as unknown as WsConnection, fakeReq('192.168.1.50'));
  h.onText(JSON.stringify({ t: 'inject-hello', sessionToken: 'tok' }));
  assert.equal(conn.closed?.code, 1008);
  assert.equal(inj.events.length, 0);
});

test('/inject rejects a bad session token', () => {
  const inj = new RecordingInjector();
  const conn = new FakeConn();
  const h = injectWsHandler(stubBroker(['good']), inj)(conn as unknown as WsConnection, fakeReq('127.0.0.1'));
  h.onText(JSON.stringify({ t: 'inject-hello', sessionToken: 'bad' }));
  assert.equal(conn.closed?.code, 1008);
});

test('/inject ignores events until enabled, then injects', () => {
  const inj = new RecordingInjector();
  const conn = new FakeConn();
  const h = injectWsHandler(stubBroker(['tok']), inj)(conn as unknown as WsConnection, fakeReq('127.0.0.1'));

  h.onText(JSON.stringify({ t: 'inject-hello', sessionToken: 'tok' }));
  assert.deepEqual(conn.sent, [{ t: 'inject-ready' }]);

  // Enabled OFF by default: event is dropped.
  h.onText(JSON.stringify({ i: 'pmove', x: 0.5, y: 0.5 }));
  assert.equal(inj.events.length, 0);

  // Opt in, then the same event is injected.
  h.onText(JSON.stringify({ t: 'inject-enable', enabled: true }));
  h.onText(JSON.stringify({ i: 'pmove', x: 0.5, y: 0.5 }));
  assert.equal(inj.events.length, 1);
  assert.deepEqual(inj.events[0], { i: 'pmove', x: 0.5, y: 0.5 });

  // Toggle back off.
  h.onText(JSON.stringify({ t: 'inject-enable', enabled: false }));
  h.onText(JSON.stringify({ i: 'pmove', x: 0.1, y: 0.1 }));
  assert.equal(inj.events.length, 1);
});
