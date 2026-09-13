/**
 * Serve dist/ as plain static files — no broker, no /config, no /signal —
 * the way GitHub Pages (or any file host) serves the published app. Used by
 * the standalone e2e project to prove the page falls back to the in-tab
 * loopback transport and the demo still pairs and streams.
 *
 *   node scripts/serve-static.mjs            # http://localhost:8092/
 *   PORT=9000 BASE=/tether/app node scripts/serve-static.mjs
 *
 * BASE mounts dist under a sub-path so the relative asset URLs get exercised
 * the way they are on Pages.
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist');
const port = Number(process.env.PORT ?? 8092);
const base = (process.env.BASE ?? '').replace(/\/$/, '');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  let path = url.pathname;
  if (base) {
    if (path === base) {
      res.writeHead(302, { location: `${base}/` });
      return res.end();
    }
    if (!path.startsWith(`${base}/`)) {
      res.writeHead(404);
      return res.end('not found');
    }
    path = path.slice(base.length);
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, decodeURIComponent(path)));
  if (!file.startsWith(resolve(root)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<h1>404</h1>'); // like Pages: an HTML 404, not JSON
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`[static] serving ${root} at http://localhost:${port}${base}/`);
});
