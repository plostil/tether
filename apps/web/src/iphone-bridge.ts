/**
 * Client for the local iPhone bridge (apps/ios-bridge). The bridge runs on the
 * PC over USB; the web page talks to it on 127.0.0.1:8090 with a token the
 * bridge printed. Coordinates sent here are normalized 0..1; the bridge scales
 * them to device points.
 */

import type { BridgeSnapshot } from './iphone-types.ts';

export class BridgeClient {
  constructor(
    private readonly base: string,
    private readonly token: string,
  ) {}

  private headers(): HeadersInit {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  async status(): Promise<BridgeSnapshot | null> {
    try {
      const r = await fetch(`${this.base}/iphone/status`, { headers: this.headers() });
      return r.ok ? ((await r.json()) as BridgeSnapshot) : null;
    } catch {
      return null;
    }
  }

  /** Subscribe to live bridge state over Server-Sent Events. */
  events(onSnap: (s: BridgeSnapshot) => void): () => void {
    const es = new EventSource(`${this.base}/iphone/events?token=${encodeURIComponent(this.token)}`);
    es.onmessage = (e) => {
      try {
        onSnap(JSON.parse(e.data) as BridgeSnapshot);
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }

  start(): Promise<Response> {
    return fetch(`${this.base}/iphone/start`, { method: 'POST', headers: this.headers() });
  }
  stop(): Promise<Response> {
    return fetch(`${this.base}/iphone/stop`, { method: 'POST', headers: this.headers() });
  }

  streamUrl(): string {
    return `${this.base}/iphone/stream?token=${encodeURIComponent(this.token)}`;
  }

  private post(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.base}/iphone${path}`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
  }

  tap(x: number, y: number): Promise<Response> {
    return this.post('/tap', { x, y });
  }
  drag(fromX: number, fromY: number, toX: number, toY: number, duration = 0.3): Promise<Response> {
    return this.post('/drag', { fromX, fromY, toX, toY, duration });
  }
  keys(text: string): Promise<Response> {
    return this.post('/keys', { text });
  }
  button(name: 'home' | 'lock' | 'volumeUp' | 'volumeDown'): Promise<Response> {
    return this.post('/button', { name });
  }
}
