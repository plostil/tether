import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Broker, type Connection } from '../src/broker.ts';
import { generateDeviceKeypair, PROTOCOL_VERSION, type ServerMessage } from '@tether/protocol';

class FakeConn implements Connection {
  readonly id: string;
  readonly sent: ServerMessage[] = [];
  closed = false;
  closeReason: string | null = null;
  constructor(id: string) {
    this.id = id;
  }
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(_code?: number, reason?: string): void {
    this.closed = true;
    this.closeReason = reason ?? null;
  }
  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}

function registerMsg(kp = generateDeviceKeypair()) {
  return {
    kp,
    msg: {
      t: 'register' as const,
      protocolVersion: PROTOCOL_VERSION,
      deviceId: kp.deviceId,
      publicKey: Buffer.from(kp.rawPublicKey).toString('base64'),
      capabilities: {},
    },
  };
}

test('valid registration is accepted', () => {
  const broker = new Broker();
  const conn = new FakeConn('1');
  broker.onConnect(conn);
  const { msg } = registerMsg();
  broker.onMessage(conn, msg);
  assert.equal(conn.last()?.t, 'registered');
  assert.equal(broker.onlineCount, 1);
});

test('registration with a spoofed device id is rejected', () => {
  const broker = new Broker();
  const conn = new FakeConn('1');
  broker.onConnect(conn);
  const { msg } = registerMsg();
  broker.onMessage(conn, { ...msg, deviceId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  const last = conn.last();
  assert.equal(last?.t, 'error');
  assert.equal(last && 'code' in last ? last.code : '', 'id-key-mismatch');
  assert.equal(broker.onlineCount, 0);
});

test('protocol version mismatch is rejected', () => {
  const broker = new Broker();
  const conn = new FakeConn('1');
  broker.onConnect(conn);
  const { msg } = registerMsg();
  broker.onMessage(conn, { ...msg, protocolVersion: PROTOCOL_VERSION + 99 });
  const last = conn.last();
  assert.equal(last && 'code' in last ? last.code : '', 'unsupported-version');
});

test('relay routes an opaque payload to the target peer', () => {
  const broker = new Broker();
  const a = new FakeConn('a');
  const b = new FakeConn('b');
  broker.onConnect(a);
  broker.onConnect(b);
  const ra = registerMsg();
  const rb = registerMsg();
  broker.onMessage(a, ra.msg);
  broker.onMessage(b, rb.msg);

  broker.onMessage(a, { t: 'relay', to: rb.kp.deviceId, payload: 'AQID' });
  const deliver = b.last();
  assert.equal(deliver?.t, 'deliver');
  assert.equal(deliver && 'from' in deliver ? deliver.from : '', ra.kp.deviceId);
  assert.equal(deliver && 'payload' in deliver ? deliver.payload : '', 'AQID');
});

test('relay to an offline peer returns peer-offline', () => {
  const broker = new Broker();
  const a = new FakeConn('a');
  broker.onConnect(a);
  const ra = registerMsg();
  broker.onMessage(a, ra.msg);
  broker.onMessage(a, { t: 'relay', to: 'SOMEOFFLINEDEVICEIDXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', payload: 'AA' });
  const last = a.last();
  assert.equal(last && 'code' in last ? last.code : '', 'peer-offline');
});

test('relay before registration is refused', () => {
  const broker = new Broker();
  const a = new FakeConn('a');
  broker.onConnect(a);
  broker.onMessage(a, { t: 'relay', to: 'x', payload: 'AA' });
  const last = a.last();
  assert.equal(last && 'code' in last ? last.code : '', 'not-registered');
});

test('watch delivers presence transitions', () => {
  const broker = new Broker();
  const watcher = new FakeConn('w');
  broker.onConnect(watcher);
  broker.onMessage(watcher, registerMsg().msg);

  const targetReg = registerMsg();
  // Watch before target is online.
  broker.onMessage(watcher, { t: 'watch', deviceId: targetReg.kp.deviceId });
  assert.deepEqual(watcher.last(), {
    t: 'peer-status',
    deviceId: targetReg.kp.deviceId,
    online: false,
  });

  // Target comes online.
  const target = new FakeConn('t');
  broker.onConnect(target);
  broker.onMessage(target, targetReg.msg);
  assert.deepEqual(watcher.last(), {
    t: 'peer-status',
    deviceId: targetReg.kp.deviceId,
    online: true,
  });

  // Target disconnects.
  broker.onDisconnect(target);
  assert.deepEqual(watcher.last(), {
    t: 'peer-status',
    deviceId: targetReg.kp.deviceId,
    online: false,
  });
});

test('a second registration displaces and closes the older connection', () => {
  const broker = new Broker();
  const kp = generateDeviceKeypair();
  const first = new FakeConn('1');
  const second = new FakeConn('2');
  broker.onConnect(first);
  broker.onConnect(second);
  broker.onMessage(first, registerMsg(kp).msg);
  broker.onMessage(second, registerMsg(kp).msg);

  assert.equal(first.closed, true);
  assert.equal(broker.onlineCount, 1);
  assert.equal(broker.isOnline(kp.deviceId), true);

  // The displaced connection disconnecting must not evict the new owner.
  broker.onDisconnect(first);
  assert.equal(broker.isOnline(kp.deviceId), true);
});

test('relay rate limit trips after the bucket drains', () => {
  let clock = 0;
  const broker = new Broker({ relayRatePerSec: 2, now: () => clock });
  const a = new FakeConn('a');
  const b = new FakeConn('b');
  broker.onConnect(a);
  broker.onConnect(b);
  const ra = registerMsg();
  const rb = registerMsg();
  broker.onMessage(a, ra.msg);
  broker.onMessage(b, rb.msg);

  const relay = { t: 'relay' as const, to: rb.kp.deviceId, payload: 'AA' };
  broker.onMessage(a, relay); // token 2 -> 1
  broker.onMessage(a, relay); // token 1 -> 0
  broker.onMessage(a, relay); // blocked
  assert.equal(a.last()?.t, 'error');
  assert.equal(a.last() && 'code' in a.last()! ? (a.last() as { code: string }).code : '', 'rate-limited');

  // After a second, the bucket refills.
  clock += 1000;
  broker.onMessage(a, relay);
  assert.equal(b.last()?.t, 'deliver');
});
