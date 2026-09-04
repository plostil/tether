/**
 * Smoke alarm: two Node clients pair over the REAL WebSocket broker (not the
 * in-memory Connection used by apps/server/test/integration.test.ts) and
 * exchange encrypted messages. If this fails, the demo is broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDemo } from '../src/demo.ts';

test('two devices pair over a live WebSocket broker and exchange encrypted messages', async () => {
  const r = await runDemo();
  assert.match(r.url, /^ws:\/\/127\.0\.0\.1:\d+\/signal$/);
  assert.notEqual(r.phoneId, r.pcId);
  assert.deepEqual(r.pcInbox, ['unlock-session: phone→pc']);
  assert.deepEqual(r.phoneInbox, ['ack: pc→phone']);
  assert.equal(r.ok, true);
});
