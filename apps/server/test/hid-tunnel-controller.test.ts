import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn as spawnType } from 'node:child_process';
import {
  dragLine,
  HidTunnelController,
  tapLine,
} from '../src/ios-control/hid-tunnel-controller.ts';
import type { IosStatus } from '../src/ios-control/backend.ts';

// ---- pure gesture-line helpers (0..65535 HID space) -------------------------

test('tapLine / dragLine map normalized coords to the 0..65535 HID space', () => {
  assert.equal(tapLine(0.5, 0.5), 'tap 32768 32768');
  assert.equal(tapLine(0, 1), 'tap 0 65535');
  assert.equal(dragLine(0.1, 0.1, 0.9, 0.9), 'drag 6554 6554 58982 58982');
});

// ---- persistent session child driven by a fake spawn ------------------------

class FakeChild extends EventEmitter {
  writes: string[] = [];
  killed = false;
  readonly args: string[];
  stdin = {
    writable: true,
    write: (s: string) => {
      this.writes.push(s);
      return true;
    },
    end: () => {},
  };
  constructor(args: string[]) {
    super();
    this.args = args;
  }
  kill() {
    this.killed = true;
    this.emit('exit', 0);
  }
}

function fakeSpawner(probeCode = 0) {
  const spawned: FakeChild[] = [];
  const spawn = ((_bin: string, args: string[]) => {
    const c = new FakeChild(args);
    spawned.push(c);
    // One-shot commands exit on their own; the `session` child is persistent.
    if (args.includes('get-display-info') || args.includes('screenshot')) {
      queueMicrotask(() => c.emit('exit', probeCode));
    }
    return c;
  }) as unknown as typeof spawnType;
  return { spawn, spawned };
}

function make(probeCode = 0) {
  const { spawn, spawned } = fakeSpawner(probeCode);
  const statuses: IosStatus[] = [];
  const ctrl = new HidTunnelController({ spawn, now: () => 1000, pmd3Bin: 'pmd3' });
  ctrl.setStatusListener((s) => statuses.push(s));
  return { ctrl, spawned, statuses };
}

/** The persistent `session` child (skips the probe/screenshot one-shots). */
function sessionChild(spawned: FakeChild[]): FakeChild {
  const c = spawned.find((k) => k.args.includes('session'));
  assert.ok(c, 'session child was spawned');
  return c!;
}

test('connect probes the tunnel then starts the session; a tap is a tap line', async () => {
  const { ctrl, spawned, statuses } = make(0);
  await ctrl.connect();
  assert.ok(statuses.includes('ready'));

  // The probe used the auto-discovery flag.
  assert.deepEqual(spawned[0].args, ['developer', 'core-device', 'get-display-info', '--tunnel', '']);

  ctrl.dispatch({ i: 'pdown', x: 0.5, y: 0.5, b: 0 });
  ctrl.dispatch({ i: 'pup', x: 0.5, y: 0.5, b: 0 });
  assert.deepEqual(sessionChild(spawned).writes, ['tap 32768 32768\n']);
  ctrl.close();
});

test('a displaced press+release becomes a drag line', async () => {
  const { ctrl, spawned } = make(0);
  await ctrl.connect();
  ctrl.dispatch({ i: 'pdown', x: 0.1, y: 0.1, b: 0 });
  ctrl.dispatch({ i: 'pup', x: 0.9, y: 0.9, b: 0 });
  assert.deepEqual(sessionChild(spawned).writes, ['drag 6554 6554 58982 58982\n']);
  ctrl.close();
});

test('wheel becomes a centered vertical drag', async () => {
  const { ctrl, spawned } = make(0);
  await ctrl.connect();
  ctrl.dispatch({ i: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 120 });
  assert.deepEqual(sessionChild(spawned).writes, ['drag 32768 32768 32768 16384\n']);
  ctrl.close();
});

test('a failed probe reports unreachable and injects nothing', async () => {
  const { ctrl, spawned, statuses } = make(1);
  await ctrl.connect();
  assert.ok(statuses.includes('unreachable'));
  assert.equal(ctrl.isReady(), false);
  ctrl.dispatch({ i: 'pdown', x: 0.5, y: 0.5, b: 0 });
  ctrl.dispatch({ i: 'pup', x: 0.5, y: 0.5, b: 0 });
  assert.equal(spawned.some((c) => c.args.includes('session')), false, 'no session started');
  ctrl.close();
});

test('close() kills the session child', async () => {
  const { ctrl, spawned } = make(0);
  await ctrl.connect();
  const session = sessionChild(spawned);
  ctrl.close();
  assert.equal(session.killed, true);
});

test('screenshot spawns the dvt screenshot command and is graceful on failure', async () => {
  const { ctrl, spawned } = make(0);
  await ctrl.connect();
  // No real PNG is written by the fake, so this resolves to null rather than throwing.
  const frame = await ctrl.screenshot();
  assert.equal(frame, null);
  const shot = spawned.find((c) => c.args.includes('screenshot'));
  assert.ok(shot, 'screenshot command spawned');
  assert.equal(shot!.args[shot!.args.length - 2], '--tunnel');
  ctrl.close();
});
