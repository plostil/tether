import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createBrokerServer, lanAddresses } from '../src/server.ts';
import { loadConfig } from '../src/config.ts';

/**
 * The broker optionally serves the built web client (config.webRoot) so the
 * phone reaches everything on one origin/port. Static serving must never
 * shadow the API routes or escape the web root.
 */
test('static web root serving, /net-info, and traversal protection', async () => {
  const webRoot = mkdtempSync(join(tmpdir(), 'tether-web-'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(webRoot, 'app.js'), 'export {};');

  const config = { ...loadConfig(), port: 0, host: '127.0.0.1', webRoot };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // / serves index.html with the right content type.
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await index.text(), /<title>t<\/title>/);

    // Assets resolve too.
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);

    // API routes are not shadowed by static serving.
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal(((await health.json()) as { ok: boolean }).ok, true);

    // /net-info reports plausible LAN addresses (may be empty on airgapped CI).
    const net = await fetch(`${base}/net-info`);
    assert.equal(net.status, 200);
    const info = (await net.json()) as { lanAddresses: string[] };
    assert.ok(Array.isArray(info.lanAddresses));
    assert.deepEqual(info.lanAddresses, lanAddresses());

    // Path traversal cannot escape the web root.
    const evil = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.equal(evil.status, 404);

    // Unknown files still 404.
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(webRoot, { recursive: true, force: true });
  }
});

test('static serving is off when webRoot is null', async () => {
  const config = { ...loadConfig(), port: 0, host: '127.0.0.1', webRoot: null };
  const { server } = createBrokerServer(config);
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((res) => server.close(() => res()));
  }
});
