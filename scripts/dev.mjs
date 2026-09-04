/**
 * One command: `npm run dev`
 *   1. bundle the web client (esbuild, in-process)
 *   2. start the broker (which serves the bundle)
 *   3. wait for /health, print the URL, open the browser
 *
 * Flags: --watch (rebuild on change), --no-open (never launch a browser).
 * Env:   PORT (default 8080), TETHER_DEMO=1 (auto-start demo mode), CI.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from '../apps/web/scripts/build.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const noOpen = args.includes('--no-open') || !!process.env.CI;
const port = Number(process.env.PORT ?? 8080);
const url = `http://localhost:${port}`;

await buildWeb({ watch });

const server = spawn(process.execPath, [join(repo, 'apps', 'server', 'src', 'index.ts')], {
  stdio: 'inherit',
  env: process.env,
});
server.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.kill();
    process.exit(0);
  });
}

async function waitForHealth(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function openBrowser(target) {
  const cmd =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', target]]
      : process.platform === 'darwin'
        ? ['open', [target]]
        : ['xdg-open', [target]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser available; the URL is printed anyway */
  }
}

if (await waitForHealth()) {
  console.log(`\n[tether] ready → ${url}${process.env.TETHER_DEMO ? '  (demo mode)' : ''}\n`);
  if (!noOpen) openBrowser(url);
} else {
  console.error('[tether] server did not become healthy in time');
}
