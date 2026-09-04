import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Orchestrator, type Spawner } from '../src/supervisor.ts';
import { toPoints } from '../src/api.ts';

/** A fake child process: emits a ready line, then behaves per longLived. */
function fakeSpawner(behavior: Record<string, { readyLine?: string; exitCode?: number }>): Spawner {
  return (cmd, args) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 1234;
    child.kill = () => {};
    const key = args[0]!; // 'tunnel' | 'image' | 'forward' | 'runwda'
    const b = behavior[key] ?? {};
    setImmediate(() => {
      if (b.readyLine) child.stdout.emit('data', Buffer.from(b.readyLine + '\n'));
      if (b.exitCode !== undefined) child.emit('exit', b.exitCode);
    });
    return child;
  };
}

test('orchestrator brings the pipeline up in order and reports running steps', async () => {
  let wdaUp = false;
  const spawner = fakeSpawner({
    tunnel: { readyLine: 'Tunnel established' },
    image: { exitCode: 0 }, // one-shot success
    forward: {}, // long-lived, no ready pattern → ready after spawn
    runwda: {}, // ready via probe
  });
  const orch = new Orchestrator({
    iosBin: 'ios',
    wdaBundleId: 'com.x.WebDriverAgentRunner.xctrunner',
    xctestConfig: 'WebDriverAgentRunner.xctest',
    spawner,
    wdaReady: async () => wdaUp,
  });
  orch.plan();
  setTimeout(() => (wdaUp = true), 200); // WDA answers /status shortly after runwda starts

  await orch.run();
  assert.equal(orch.steps.length, 5);
  assert.deepEqual(orch.steps.map((s) => s.name), ['tunnel', 'image', 'forward-wda', 'forward-mjpeg', 'runwda']);
  for (const s of orch.steps) assert.equal(s.state, 'running', `${s.name} should be running`);
  orch.stopAll();
});

test('a step that exits early fails the run instead of hanging', async () => {
  const spawner = fakeSpawner({ tunnel: { exitCode: 1 } }); // long-lived tunnel dies
  const orch = new Orchestrator({ iosBin: 'ios', wdaBundleId: 'b.xctrunner', xctestConfig: 'x.xctest', spawner, wdaReady: async () => true });
  orch.plan();
  await assert.rejects(orch.run(), /tunnel/);
  orch.stopAll();
});

test('normalized coordinates scale to device points', () => {
  const size = { width: 390, height: 844 }; // iPhone points
  assert.deepEqual(toPoints(size, 0, 0), { x: 0, y: 0 });
  assert.deepEqual(toPoints(size, 1, 1), { x: 390, y: 844 });
  assert.deepEqual(toPoints(size, 0.5, 0.25), { x: 195, y: 211 });
});
