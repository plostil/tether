/**
 * IosController — translates the normalized {@link InputEvent} stream into
 * WebDriverAgent gestures (the third consumer of the shared input schema, after
 * Windows SendInput and Android's gesture synthesis; see
 * packages/protocol/src/input.ts).
 *
 * iOS has no continuous-pointer injection, so a press+release is synthesized
 * into a discrete tap (small displacement) or swipe/drag (large), mirroring
 * apps/android/.../control/InputReceiver.kt. Coordinates arrive normalized
 * 0..1 of the shared frame and are scaled by the cached WDA window size (points).
 *
 * A failed WDA call (dead session, expired cert) drops the cached session and
 * schedules a backoff reconnect — the same restart-with-backoff shape as
 * apps/server/src/inject/injector.ts.
 */

import type { InputEvent } from '@tether/protocol';
import type { IosControlBackend, IosStatus } from './backend.ts';
import { type FetchLike, WdaClient, type WdaWindowSize } from './wda-client.ts';

export interface IosControllerOptions {
  /** Injectable WDA client for tests; when absent one is built per {@link connect}. */
  client?: WdaClient;
  /** Injected into per-connect WdaClients when no `client` is supplied. */
  fetchFn?: FetchLike;
  /** Wall clock in ms; injectable for tests. */
  now?: () => number;
  /** Tap vs swipe threshold, as a fraction of the smaller window dimension. */
  tapSlopFrac?: number;
  /** A press held longer than this (with little movement) still counts as a tap. */
  tapMaxMs?: number;
  /** Reconnect backoff after a WDA failure, ms. */
  reconnectDelayMs?: number;
}

export class IosController implements IosControlBackend {
  private readonly makeClient: (baseUrl: string) => WdaClient;
  private readonly injectedClient: WdaClient | null;
  private readonly now: () => number;
  private readonly tapSlopFrac: number;
  private readonly tapMaxMs: number;
  private readonly reconnectDelayMs: number;

  private client: WdaClient | null = null;
  private size: WdaWindowSize | null = null;
  private lastBaseUrl: string | null = null;
  private reconnecting = false;
  private closed = false;
  private statusListener: ((s: IosStatus, message?: string) => void) | null = null;

  // Pointer-gesture accumulation, in WDA points.
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private downAt = 0;
  private pressed = false;

  constructor(opts: IosControllerOptions = {}) {
    this.injectedClient = opts.client ?? null;
    const fetchFn = opts.fetchFn;
    this.makeClient = (baseUrl) => new WdaClient({ baseUrl, fetchFn });
    this.now = opts.now ?? Date.now;
    this.tapSlopFrac = opts.tapSlopFrac ?? 0.02;
    this.tapMaxMs = opts.tapMaxMs ?? 400;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1500;
  }

  /** The active channel registers here so mid-session failures reach the UI. */
  setStatusListener(fn: ((s: IosStatus, message?: string) => void) | null): void {
    this.statusListener = fn;
  }

  /** True once a session + window size are cached and control can flow. */
  isReady(): boolean {
    return this.size !== null && this.client !== null;
  }

  /**
   * Dial a WDA endpoint, create a session, and cache the window size. Throws on
   * failure so the caller can surface `ios-error`.
   */
  async connect(target?: string): Promise<void> {
    if (!target) throw new Error('WDA backend requires a WDA URL');
    const baseUrl = target;
    this.closed = false;
    this.lastBaseUrl = baseUrl;
    this.emit('connecting');
    const client = this.injectedClient ?? this.makeClient(baseUrl);
    client.reset();
    await client.ensureSession();
    this.size = await client.windowSizePoints();
    this.client = client;
    this.emit('ready');
  }

  /** Feed one input event. Terminal WDA calls fire-and-forget with failure recovery. */
  dispatch(ev: InputEvent): void {
    if (!this.isReady() || this.size === null) return;
    const { width, height } = this.size;
    switch (ev.i) {
      case 'pdown':
        this.downX = this.lastX = clamp(ev.x * width, width);
        this.downY = this.lastY = clamp(ev.y * height, height);
        this.downAt = this.now();
        this.pressed = true;
        break;
      case 'pmove':
        if (this.pressed) {
          this.lastX = clamp(ev.x * width, width);
          this.lastY = clamp(ev.y * height, height);
        }
        break;
      case 'pup': {
        if (!this.pressed) break;
        this.pressed = false;
        this.lastX = clamp(ev.x * width, width);
        this.lastY = clamp(ev.y * height, height);
        this.dispatchGesture();
        break;
      }
      case 'wheel': {
        // A vertical swipe from center; content scrolls opposite the wheel sign.
        const cx = width / 2;
        const cy = height / 2;
        const throwPx = ev.dy > 0 ? -height * 0.25 : height * 0.25;
        this.run(this.client!.swipe(cx, cy, cx, clamp(cy + throwPx, height), 120));
        break;
      }
      case 'text':
        this.run(this.client!.typeText(ev.text));
        break;
      case 'nav':
        // iOS has only Home; back/recents have no analogue.
        if (ev.action === 'home') this.run(this.client!.pressHome());
        break;
      // 'key': iOS has no stock keystroke injection — typing rides 'text'.
    }
  }

  /** Current base64 PNG, or null when not ready (so the pump can skip a frame). */
  async screenshot(): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.screenshotBase64();
    } catch (err) {
      this.onFailure(err);
      return null;
    }
  }

  /** Stop accepting events and drop the session; no reconnect after this. */
  close(): void {
    this.closed = true;
    this.client = null;
    this.size = null;
    this.pressed = false;
  }

  private dispatchGesture(): void {
    if (!this.client) return;
    const dist = Math.hypot(this.lastX - this.downX, this.lastY - this.downY);
    const held = this.now() - this.downAt;
    const slop = Math.min(this.size!.width, this.size!.height) * this.tapSlopFrac;
    if (dist < slop && held < this.tapMaxMs) {
      this.run(this.client.tap(this.downX, this.downY));
    } else {
      const dur = Math.min(600, Math.max(60, held));
      this.run(this.client.swipe(this.downX, this.downY, this.lastX, this.lastY, dur));
    }
  }

  private run(p: Promise<void>): void {
    p.catch((err) => this.onFailure(err));
  }

  private onFailure(err: unknown): void {
    if (this.closed) return;
    this.client?.reset();
    this.size = null;
    this.emit('unreachable', err instanceof Error ? err.message : String(err));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed || !this.lastBaseUrl) return;
    this.reconnecting = true;
    const baseUrl = this.lastBaseUrl;
    setTimeout(() => {
      this.reconnecting = false;
      if (this.closed) return;
      this.connect(baseUrl).catch((err) => this.onFailure(err));
    }, this.reconnectDelayMs).unref?.();
  }

  private emit(s: IosStatus, message?: string): void {
    this.statusListener?.(s, message);
  }
}

function clamp(v: number, max: number): number {
  return v < 0 ? 0 : v > max - 1 ? max - 1 : v;
}
