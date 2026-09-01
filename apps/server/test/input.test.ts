import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInputEvent,
  encodeInputEvent,
  decodeInputEvent,
  negotiateSession,
  negotiateVideo,
  ANDROID_STOCK_CAPS,
  WINDOWS_CAPS,
  IOS_CAPS,
  WINDOWS_MEDIA_CAPS,
  ANDROID_STOCK_MEDIA_CAPS,
  type InputEvent,
  type SessionRequest,
} from '@tether/protocol';

test('parseInputEvent accepts every event shape', () => {
  const good: InputEvent[] = [
    { i: 'pmove', x: 0, y: 1 },
    { i: 'pmove', x: 0.5, y: 0.25 },
    { i: 'pdown', x: 0.1, y: 0.9, b: 0 },
    { i: 'pup', x: 0.1, y: 0.9, b: 2 },
    { i: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: -120 },
    { i: 'key', code: 'KeyA', down: true },
    { i: 'key', code: 'ArrowLeft', down: false },
    { i: 'text', text: 'héllo 🌍' },
    { i: 'nav', action: 'back' },
    { i: 'nav', action: 'recents' },
  ];
  for (const ev of good) {
    assert.deepEqual(parseInputEvent(ev), ev, `should accept ${JSON.stringify(ev)}`);
  }
});

test('parseInputEvent rejects malformed events', () => {
  const bad: unknown[] = [
    null,
    'pmove',
    {},
    { i: 'pmove', x: 0.5 }, // missing y
    { i: 'pmove', x: -0.1, y: 0.5 }, // out of range
    { i: 'pmove', x: 1.5, y: 0.5 }, // out of range
    { i: 'pmove', x: NaN, y: 0.5 },
    { i: 'pmove', x: '0.5', y: 0.5 }, // wrong type
    { i: 'pdown', x: 0.5, y: 0.5, b: 3 }, // bad button
    { i: 'pdown', x: 0.5, y: 0.5 }, // missing button
    { i: 'wheel', x: 0.5, y: 0.5, dx: Infinity, dy: 0 },
    { i: 'key', code: '', down: true }, // empty code
    { i: 'key', code: 'KeyA', down: 'yes' },
    { i: 'text', text: '' }, // empty text
    { i: 'nav', action: 'launch' }, // unknown action
    { i: 'unknown', x: 0, y: 0 },
  ];
  for (const ev of bad) {
    assert.equal(parseInputEvent(ev), null, `should reject ${JSON.stringify(ev)}`);
  }
});

test('encode/decode round-trips an event', () => {
  const ev: InputEvent = { i: 'pdown', x: 0.125, y: 0.875, b: 0 };
  assert.deepEqual(decodeInputEvent(encodeInputEvent(ev)), ev);
});

test('decodeInputEvent returns null on garbage', () => {
  assert.equal(decodeInputEvent('not json'), null);
  assert.equal(decodeInputEvent('{"i":"pmove"}'), null);
});

// ---- remote-control negotiation matrix --------------------------------------

test('phone can control a windows PC via sendinput', () => {
  const req: SessionRequest = { kind: 'remote-control', source: 'phone', sink: 'pc' };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, true);
});

test('an iOS phone may still drive a PC (canControlPeer)', () => {
  const req: SessionRequest = { kind: 'remote-control', source: 'phone', sink: 'pc' };
  const r = negotiateSession(req, IOS_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, true);
});

test('controlling an iOS device stays rejected', () => {
  const req: SessionRequest = { kind: 'remote-control', source: 'pc', sink: 'phone' };
  const r = negotiateSession(req, WINDOWS_CAPS, IOS_CAPS);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /not controllable/);
});

test('a sink advertising controllableVia none is rejected', () => {
  const uncontrollable = {
    ...WINDOWS_CAPS,
    remoteControl: { ...WINDOWS_CAPS.remoteControl, controllableVia: 'none' as const },
  };
  const req: SessionRequest = { kind: 'remote-control', source: 'phone', sink: 'pc' };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, uncontrollable);
  assert.equal(r.ok, false);
});

// ---- phone-to-pc video still follows codec policy ---------------------------

test('phone-to-pc video never selects AV1 (no HW encode on phones)', () => {
  const r = negotiateVideo('phone-to-pc', ANDROID_STOCK_MEDIA_CAPS, WINDOWS_MEDIA_CAPS);
  assert.ok(r);
  assert.notEqual(r.codec, 'av1');
});
