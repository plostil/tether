import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type FetchLike, type FetchResponse, WdaClient } from '../src/ios-control/wda-client.ts';

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** A fake WDA HTTP server: records requests, answers by path suffix. */
function fakeWda(overrides: Partial<Record<string, unknown>> = {}): {
  fetchFn: FetchLike;
  calls: Recorded[];
  failNext: () => void;
} {
  const calls: Recorded[] = [];
  let fail = false;
  const answer = (path: string): unknown => {
    if (path.endsWith('/session')) return { value: { sessionId: 'S1' }, sessionId: 'S1' };
    if (path.endsWith('/window/size')) return { value: { width: 390, height: 844 } };
    if (path.endsWith('/screenshot')) return { value: 'PNGDATA' };
    if (path.endsWith('/status')) return { value: {} };
    return overrides[path] ?? { value: null };
  };
  const fetchFn: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({
      method: init?.method ?? 'GET',
      path,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    if (fail) {
      fail = false;
      return { ok: false, status: 500, json: async () => ({}), text: async () => '' } as FetchResponse;
    }
    const value = answer(path);
    return { ok: true, status: 200, json: async () => value, text: async () => '' } as FetchResponse;
  };
  return { fetchFn, calls, failNext: () => (fail = true) };
}

test('ensureSession creates a session once and caches it', async () => {
  const { fetchFn, calls } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100/', fetchFn });
  assert.equal(await c.ensureSession(), 'S1');
  await c.ensureSession();
  assert.equal(calls.filter((k) => k.path === '/session').length, 1, 'session created exactly once');
});

test('windowSizePoints caches the device size', async () => {
  const { fetchFn, calls } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  assert.deepEqual(await c.windowSizePoints(), { width: 390, height: 844 });
  await c.windowSizePoints();
  assert.equal(calls.filter((k) => k.path.endsWith('/window/size')).length, 1);
});

test('tap posts a W3C pointer sequence to /actions', async () => {
  const { fetchFn, calls } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  await c.tap(120, 240);
  const actions = calls.find((k) => k.path === '/session/S1/actions');
  assert.ok(actions, 'hit /actions');
  const seq = (actions!.body as { actions: { actions: unknown[] }[] }).actions[0].actions;
  assert.deepEqual(seq, [
    { type: 'pointerMove', duration: 0, x: 120, y: 240 },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 60 },
    { type: 'pointerUp', button: 0 },
  ]);
});

test('swipe posts a moved pointer sequence with the duration', async () => {
  const { fetchFn, calls } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  await c.swipe(10, 20, 300, 400, 250);
  const seq = (calls.find((k) => k.path === '/session/S1/actions')!.body as {
    actions: { actions: { type: string; x?: number; duration?: number }[] }[];
  }).actions[0].actions;
  assert.deepEqual(seq[0], { type: 'pointerMove', duration: 0, x: 10, y: 20 });
  assert.deepEqual(seq[2], { type: 'pointerMove', duration: 250, x: 300, y: 400 });
});

test('typeText and pressHome hit the wda helper endpoints', async () => {
  const { fetchFn, calls } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  await c.typeText('Hi');
  await c.pressHome();
  const keys = calls.find((k) => k.path === '/session/S1/wda/keys');
  assert.deepEqual(keys!.body, { value: ['H', 'i'] });
  assert.ok(calls.some((k) => k.path === '/session/S1/wda/homescreen' && k.method === 'POST'));
});

test('screenshotBase64 returns the value field', async () => {
  const { fetchFn } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  assert.equal(await c.screenshotBase64(), 'PNGDATA');
});

test('a WDA failure rejects, and reset() forces a fresh session', async () => {
  const { fetchFn, calls, failNext } = fakeWda();
  const c = new WdaClient({ baseUrl: 'http://phone:8100', fetchFn });
  await c.ensureSession();
  failNext();
  await assert.rejects(() => c.tap(1, 1), /-> 500/);
  c.reset();
  await c.ensureSession();
  assert.equal(calls.filter((k) => k.path === '/session').length, 2, 'reset re-created the session');
});
