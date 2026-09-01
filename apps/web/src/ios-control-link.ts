/**
 * PC-side bridge from the browser to the co-located server's `/ios-control`
 * channel, plus the capture that turns mouse/touch/keyboard on the iPhone
 * screenshot into normalized {@link InputEvent}s.
 *
 * Counterpart to inject-link.ts, but inverted: here the PC browser is the
 * CONTROLLER. It paints WDA screenshots (the crude v1 "view") and captures local
 * pointer input over them, forwarding events to the server, which replays them
 * on the iPhone via WebDriverAgent. The socket targets 127.0.0.1, so it only
 * connects on the PC beside the server — on a phone the connect simply fails and
 * the panel stays hidden.
 */

import type { InputEvent } from '@tether/protocol/browser';

export type IosStatus = 'ready' | 'connecting' | 'unreachable';

interface Pt {
  x: number;
  y: number;
}

export class IosControlLink {
  private ws: WebSocket | null = null;
  private open = false;
  private enabled = false;
  private detachFn: (() => void) | null = null;

  constructor(
    private readonly getToken: () => string | null,
    private readonly onStatus: (s: IosStatus, message?: string) => void,
    private readonly onFrame: (pngB64: string) => void,
    private readonly log: (s: string) => void,
    /** Reports the active backend ('hid' needs no WDA URL). */
    private readonly onBackend: (backend: 'wda' | 'hid') => void = () => {},
  ) {}

  /**
   * Open the localhost channel and hand it the WDA target. Resolves true if the
   * socket opened (i.e. we are on the PC beside the server), regardless of
   * whether WDA itself is reachable yet — WDA state arrives via {@link onStatus}.
   */
  connect(wdaUrl: string): Promise<boolean> {
    this.closeSocket();
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${location.port || '80'}/ios-control`);
      } catch {
        done(false);
        return;
      }
      this.ws = ws;
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        done(false);
      }, 1500);
      ws.onopen = () => {
        clearTimeout(timeout);
        const token = this.getToken();
        if (!token) {
          ws.close();
          done(false);
          return;
        }
        this.open = true;
        ws.send(JSON.stringify({ t: 'ios-hello', sessionToken: token, wdaUrl: wdaUrl || undefined }));
        if (this.enabled) ws.send(JSON.stringify({ t: 'ios-enable', enabled: true }));
        this.log('iOS control channel connected on this PC');
        done(true);
      };
      ws.onmessage = (e) => {
        let m: { t?: string; status?: IosStatus; message?: string; png?: string; backend?: 'wda' | 'hid' };
        try {
          m = JSON.parse(String(e.data));
        } catch {
          return;
        }
        if (m.t === 'ios-frame' && typeof m.png === 'string') this.onFrame(m.png);
        else if (m.t === 'ios-status' && m.status) this.onStatus(m.status, m.message);
        else if (m.t === 'ios-info' && m.backend) this.onBackend(m.backend);
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        done(false);
      };
      ws.onclose = () => {
        this.open = false;
      };
    });
  }

  /** Runtime opt-in from the PC UI; also drives the server-side gate. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ws && this.open && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'ios-enable', enabled: on }));
    }
  }

  /**
   * Capture pointer/wheel/keyboard over the screenshot `<img>` and stream events.
   * Coordinates are normalized 0..1 within the image's letterboxed content
   * (object-fit: contain), matching the server's coordinate contract.
   */
  attachInput(img: HTMLImageElement, keyboardInput: HTMLInputElement): void {
    this.detachFn?.();

    let buttonDown = false;
    let rafPending = false;
    let pendingMove: Pt | null = null;

    const norm = (clientX: number, clientY: number): Pt | null => {
      const r = img.getBoundingClientRect();
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      if (!iw || !ih || !r.width || !r.height) return null;
      const s = Math.min(r.width / iw, r.height / ih);
      const cw = iw * s;
      const ch = ih * s;
      const ox = (r.width - cw) / 2;
      const oy = (r.height - ch) / 2;
      const x = (clientX - r.left - ox) / cw;
      const y = (clientY - r.top - oy) / ch;
      if (x < 0 || x > 1 || y < 0 || y > 1) return null;
      return { x, y };
    };

    const flushMove = (): void => {
      rafPending = false;
      if (pendingMove) {
        this.send({ i: 'pmove', x: pendingMove.x, y: pendingMove.y });
        pendingMove = null;
      }
    };

    const onDown = (e: PointerEvent): void => {
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      img.setPointerCapture?.(e.pointerId);
      this.send({ i: 'pmove', x: p.x, y: p.y });
      this.send({ i: 'pdown', x: p.x, y: p.y, b: 0 });
      buttonDown = true;
    };
    const onMove = (e: PointerEvent): void => {
      if (!buttonDown) return;
      const p = norm(e.clientX, e.clientY);
      if (!p) return;
      pendingMove = p;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(flushMove);
      }
    };
    const onUp = (e: PointerEvent): void => {
      if (!buttonDown) return;
      buttonDown = false;
      img.releasePointerCapture?.(e.pointerId);
      const p = norm(e.clientX, e.clientY);
      this.send({ i: 'pup', x: p ? p.x : 0.5, y: p ? p.y : 0.5, b: 0 });
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const p = norm(e.clientX, e.clientY) ?? { x: 0.5, y: 0.5 };
      this.send({ i: 'wheel', x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
    };
    const onInput = (): void => {
      const text = keyboardInput.value;
      if (text) this.send({ i: 'text', text });
      keyboardInput.value = '';
    };

    img.addEventListener('pointerdown', onDown);
    img.addEventListener('pointermove', onMove);
    img.addEventListener('pointerup', onUp);
    img.addEventListener('pointercancel', onUp);
    img.addEventListener('wheel', onWheel, { passive: false });
    keyboardInput.addEventListener('input', onInput);

    this.detachFn = () => {
      img.removeEventListener('pointerdown', onDown);
      img.removeEventListener('pointermove', onMove);
      img.removeEventListener('pointerup', onUp);
      img.removeEventListener('pointercancel', onUp);
      img.removeEventListener('wheel', onWheel);
      keyboardInput.removeEventListener('input', onInput);
    };
  }

  private send(ev: InputEvent): void {
    if (!this.open || !this.enabled || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(ev));
  }

  close(): void {
    this.detachFn?.();
    this.detachFn = null;
    this.closeSocket();
  }

  private closeSocket(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.open = false;
  }
}
