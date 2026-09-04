import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createBrokerServer } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';

async function withServer<T>(env: NodeJS.ProcessEnv, fn: (base: string) => Promise<T>): Promise<T> {
  const config = { ...loadConfig(env), port: 0, host: '127.0.0.1' };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
}

test('/config reflects TETHER_DEMO and carries protocol hints', async () => {
  await withServer({ TETHER_DEMO: '1' }, async (base) => {
    const cfg = (await (await fetch(`${base}/config`)).json()) as Record<string, unknown>;
    assert.equal(cfg.demo, true);
    assert.equal(cfg.signalPath, '/signal');
    assert.equal(typeof cfg.protocolVersion, 'number');
    assert.equal(cfg.turn, false);
  });
  await withServer({}, async (base) => {
    const cfg = (await (await fetch(`${base}/config`)).json()) as Record<string, unknown>;
    assert.equal(cfg.demo, false);
  });
});

test('/health is unchanged', async () => {
  await withServer({}, async (base) => {
    const h = (await (await fetch(`${base}/health`)).json()) as { ok: boolean; online: number };
    assert.equal(h.ok, true);
    assert.equal(h.online, 0);
  });
});
