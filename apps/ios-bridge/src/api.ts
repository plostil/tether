/**
 * The bridge's local HTTP API (default 127.0.0.1:8090), consumed by the web
 * client's iPhone mode. Token-gated (Bearer header, or ?token= for the stream
 * and screenshot which are loaded by <img>). Coordinates come in as 0..1
 * fractions and are scaled here to device points via /window/size, so the web
 * client never needs the device scale factor.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WdaClient, WindowSize } from './wda.ts';
import { proxyMjpeg } from './mjpeg-proxy.ts';
import type { BridgeState } from './state.ts';

export interface ApiDeps {
  token: string;
  webOrigin: string;
  wda: WdaClient;
  state: BridgeState;
  start: () => Promise<void>;
  stop: () => void;
  windowSize: () => WindowSize | null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return {};
  }
}

/** Map a 0..1 fraction pair to device points. Exported for tests. */
export function toPoints(size: WindowSize, x: number, y: number): { x: number; y: number } {
  return { x: Math.round(x * size.width), y: Math.round(y * size.height) };
}

export function createApi(deps: ApiDeps): Server {
  const authed = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
    const q = url.searchParams.get('token');
    return bearer === deps.token || q === deps.token;
  };

  const cors = (res: ServerResponse): void => {
    res.setHeader('access-control-allow-origin', deps.webOrigin);
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!url.pathname.startsWith('/iphone/')) {
      send(res, 404, { error: 'not-found' });
      return;
    }
    if (!authed(req, url)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const path = url.pathname.slice('/iphone'.length);

    try {
      // Streams (loaded by <img>, so token is in the query).
      if (path === '/stream' && req.method === 'GET') {
        proxyMjpeg(res);
        return;
      }
      if (path === '/status' && req.method === 'GET') {
        send(res, 200, deps.state.snapshot());
        return;
      }
      if (path === '/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const off = deps.state.subscribe((snap) => res.write(`data: ${JSON.stringify(snap)}\n\n`));
        res.write(`data: ${JSON.stringify(deps.state.snapshot())}\n\n`);
        req.on('close', off);
        return;
      }
      if (path === '/start' && req.method === 'POST') {
        void deps.start();
        send(res, 202, { starting: true });
        return;
      }
      if (path === '/stop' && req.method === 'POST') {
        deps.stop();
        send(res, 200, { stopped: true });
        return;
      }

      // Control endpoints — need a window size to scale coordinates.
      const size = deps.windowSize();
      const body = req.method === 'POST' ? await readJson(req) : {};
      const pt = (x: number, y: number) => (size ? toPoints(size, x, y) : { x, y });

      if (path === '/tap' && req.method === 'POST') {
        const p = pt(body.x, body.y);
        await deps.wda.tap(p.x, p.y);
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/double-tap' && req.method === 'POST') {
        const p = pt(body.x, body.y);
        await deps.wda.doubleTap(p.x, p.y);
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/long-press' && req.method === 'POST') {
        const p = pt(body.x, body.y);
        await deps.wda.longPress(p.x, p.y, body.duration ?? 0.7);
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/drag' && req.method === 'POST') {
        const a = pt(body.fromX, body.fromY);
        const b = pt(body.toX, body.toY);
        await deps.wda.drag(a.x, a.y, b.x, b.y, body.duration ?? 0.3);
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/keys' && req.method === 'POST') {
        await deps.wda.keys(String(body.text ?? ''));
        send(res, 200, { ok: true });
        return;
      }
      if (path === '/button' && req.method === 'POST') {
        await deps.wda.pressButton(body.name);
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { error: 'not-found' });
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });
}
