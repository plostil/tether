import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api.ts';
import { BridgeState } from '../src/state.ts';

function fakeWda() {
  const calls: Array<{ m: string; args: unknown[] }> = [];
  const rec = (m: string) => (...args: unknown[]) => {
    calls.push({ m, args });
    return Promise.resolve({});
  };
  return {
    calls,
    tap: rec('tap'),
    doubleTap: rec('doubleTap'),
    longPress: rec('longPress'),
    drag: rec('drag'),
    keys: rec('keys'),
    pressButton: rec('pressButton'),
  } as any;
}

async function withApi(fn: (base: string, wda: ReturnType<typeof fakeWda>) => Promise<void>): Promise<void> {
  const wda = fakeWda();
  const server = createApi({
    token: 'secret',
    webOrigin: 'http://localhost:8080',
    wda,
    state: new BridgeState(),
    start: async () => {},
    stop: () => {},
    windowSize: () => ({ width: 400, height: 800 }),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base, wda);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('control endpoints require the bearer token', async () => {
  await withApi(async (base) => {
    const r = await fetch(`${base}/iphone/tap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":0.5,"y":0.5}' });
    assert.equal(r.status, 401);
  });
});

test('a tap scales normalized coords to device points before hitting WDA', async () => {
  await withApi(async (base, wda) => {
    const r = await fetch(`${base}/iphone/tap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ x: 0.5, y: 0.25 }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(wda.calls[0], { m: 'tap', args: [200, 200] }); // 0.5*400, 0.25*800
  });
});

test('keys and button are forwarded', async () => {
  await withApi(async (base, wda) => {
    await fetch(`${base}/iphone/keys`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    await fetch(`${base}/iphone/button`, { method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'home' }) });
    assert.deepEqual(wda.calls[0], { m: 'keys', args: ['hi'] });
    assert.deepEqual(wda.calls[1], { m: 'pressButton', args: ['home'] });
  });
});
