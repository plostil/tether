/**
 * Pipe WebDriverAgent's MJPEG screen stream (device port 9100, forwarded to
 * localhost) straight through to the browser. multipart/x-mixed-replace, so we
 * just relay bytes and abort cleanly when the client disconnects.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { get } from 'node:http';

export function proxyMjpeg(res: ServerResponse, source = 'http://127.0.0.1:9100'): void {
  const upstream = get(source, (up: IncomingMessage) => {
    res.writeHead(up.statusCode ?? 200, {
      'content-type': up.headers['content-type'] ?? 'multipart/x-mixed-replace',
      'cache-control': 'no-store',
    });
    up.pipe(res);
    res.on('close', () => up.destroy());
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('mjpeg upstream unavailable');
  });
}
