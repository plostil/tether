import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  negotiateSession,
  ANDROID_STOCK_CAPS,
  WINDOWS_CAPS,
  IOS_CAPS,
  type SessionRequest,
} from '@tether/protocol';

const A = 'phone';
const P = 'pc';

test('android screen can be viewed on windows', () => {
  const req: SessionRequest = { kind: 'remote-view', source: A, sink: P };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, true);
});

test('windows can control android via accessibility', () => {
  const req: SessionRequest = { kind: 'remote-control', source: P, sink: A };
  const r = negotiateSession(req, WINDOWS_CAPS, ANDROID_STOCK_CAPS);
  assert.equal(r.ok, true);
});

test('controlling an iOS device is rejected (no injection API)', () => {
  const req: SessionRequest = { kind: 'remote-control', source: P, sink: IOS_CAPS.platform === 'ios' ? 'ios' : 'x' };
  const r = negotiateSession(req, WINDOWS_CAPS, IOS_CAPS);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /not controllable/);
});

test('split mic/speaker audio routing is always rejected', () => {
  const req: SessionRequest = {
    kind: 'audio-route',
    source: A,
    sink: P,
    splitDuplexLoop: true,
  };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /split/);
});

test('whole-loop media audio routing to the PC is allowed', () => {
  const req: SessionRequest = { kind: 'audio-route', source: A, sink: P };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, true);
});

test('cellular call handoff to the PC works because the PC can be an HFP unit', () => {
  const req: SessionRequest = { kind: 'call-handoff', source: A, sink: P, cellular: true };
  const r = negotiateSession(req, ANDROID_STOCK_CAPS, WINDOWS_CAPS);
  assert.equal(r.ok, true);
});

test('cellular call handoff to a non-HFP receiver is rejected', () => {
  const req: SessionRequest = { kind: 'call-handoff', source: P, sink: A, cellular: true };
  // Android stock cannot act as an HFP unit in our profile -> reject.
  const r = negotiateSession(req, WINDOWS_CAPS, ANDROID_STOCK_CAPS);
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.reason : '', /HFP/);
});
