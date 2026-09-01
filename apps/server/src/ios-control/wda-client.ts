/**
 * WebDriverAgent (WDA) HTTP client — the PC-side driver for the W2 iOS-control
 * stack (docs/IOS-CONTROL.md).
 *
 * The iPhone is NOT a tether peer here: it runs Apple's WebDriverAgent, which
 * exposes an HTTP server on the LAN (default :8100). The co-located tether
 * server dials it and replays taps/swipes/text, exactly as the `/inject`
 * subsystem drives a local PowerShell host — the browser can't reach the LAN
 * device cleanly, so the server does. Zero runtime dependencies: Node's global
 * `fetch` is the whole transport, preserving the broker's zero-dep invariant.
 *
 * Coordinates handed to this client are in WDA POINTS (orientation-adjusted, so
 * Retina scaling is already accounted for); the caller scales normalized 0..1
 * input coords by {@link windowSizePoints}.
 */

/** Minimal subset of `fetch` this client uses; injectable for tests. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface WdaWindowSize {
  width: number;
  height: number;
}

export type Orientation = 'portrait' | 'landscape';

export interface WdaClientOptions {
  /** WDA base URL, e.g. `http://192.168.1.42:8100`. Trailing slash trimmed. */
  baseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: FetchLike;
  /** Per-request timeout, ms. */
  requestTimeoutMs?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * A stateful WDA session wrapper. A session (and the device window size) is
 * created lazily and cached; {@link reset} drops the cache so the next call
 * re-establishes it — the recovery hook for a dead/expired WDA (SPEC: cert
 * expiry ~7 days on a free Apple ID).
 */
export class WdaClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private windowSize: WdaWindowSize | null = null;

  constructor(opts: WdaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = opts.requestTimeoutMs ?? 5000;
  }

  /** Drop the cached session + window size after a failure, forcing re-create. */
  reset(): void {
    this.sessionId = null;
    this.windowSize = null;
  }

  /** Create the WDA session if absent; returns the cached session id. */
  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const j = await this.req('POST', '/session', {
      capabilities: { alwaysMatch: {}, firstMatch: [{}] },
    });
    const sid = readSessionId(j);
    if (!sid) throw new Error('WDA /session returned no sessionId');
    this.sessionId = sid;
    return sid;
  }

  /** Device window size in points (orientation-adjusted); cached. */
  async windowSizePoints(): Promise<WdaWindowSize> {
    if (this.windowSize) return this.windowSize;
    const sid = await this.ensureSession();
    const j = await this.req('GET', `/session/${sid}/window/size`);
    const v = isObj(j) && isObj(j.value) ? j.value : null;
    if (!v || typeof v.width !== 'number' || typeof v.height !== 'number') {
      throw new Error('WDA window/size returned no dimensions');
    }
    this.windowSize = { width: v.width, height: v.height };
    return this.windowSize;
  }

  /** Liveness probe / keepalive. Throws if WDA is unreachable. */
  async status(): Promise<void> {
    await this.req('GET', '/status');
  }

  /** Single tap at a point (WDA points), via the W3C Actions API. */
  async tap(x: number, y: number): Promise<void> {
    await this.performTouch([
      { type: 'pointerMove', duration: 0, x, y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerUp', button: 0 },
    ]);
  }

  /** Swipe/drag from one point to another over `durationMs` (WDA points). */
  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.performTouch([
      { type: 'pointerMove', duration: 0, x: x1, y: y1 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerMove', duration: Math.max(1, Math.round(durationMs)), x: x2, y: y2 },
      { type: 'pointerUp', button: 0 },
    ]);
  }

  /** Type committed text into the focused field. */
  async typeText(text: string): Promise<void> {
    const sid = await this.ensureSession();
    await this.req('POST', `/session/${sid}/wda/keys`, { value: Array.from(text) });
  }

  /** Press the Home button. */
  async pressHome(): Promise<void> {
    const sid = await this.ensureSession();
    await this.req('POST', `/session/${sid}/wda/homescreen`, {});
  }

  /** Current base64-encoded PNG screenshot (sessionless endpoint). */
  async screenshotBase64(): Promise<string> {
    const j = await this.req('GET', '/screenshot');
    const v = isObj(j) ? j.value : null;
    if (typeof v !== 'string' || v.length === 0) throw new Error('WDA /screenshot returned no image');
    return v;
  }

  private async performTouch(actions: unknown[]): Promise<void> {
    const sid = await this.ensureSession();
    await this.req('POST', `/session/${sid}/actions`, {
      actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }],
    });
  }

  private async req(method: string, path: string, body?: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`WDA ${method} ${path} -> ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** WDA has returned the session id at top level and/or under `value` across versions. */
function readSessionId(j: unknown): string | null {
  if (!isObj(j)) return null;
  if (typeof j.sessionId === 'string') return j.sessionId;
  if (isObj(j.value) && typeof j.value.sessionId === 'string') return j.value.sessionId;
  return null;
}
