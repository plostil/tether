/**
 * PC-side bridge from the browser to the co-located broker's `/inject` channel.
 *
 * The PC is the media SOURCE (it shares its screen); control events arrive from
 * the phone on the session's `input` DataChannel, and this browser cannot inject
 * OS input itself — so it forwards them to the localhost injection channel,
 * which calls Win32 SendInput. Key events are mapped to PC/AT scancodes HERE so
 * the server and the PowerShell host stay keymap-free.
 *
 * The channel only ever reaches a co-located broker: the WebSocket targets
 * 127.0.0.1, so on a phone (which loaded the page over the PC's LAN IP) the
 * probe simply fails and the device advertises itself as not controllable.
 */

import type { InputEvent } from '@tether/protocol/browser';
import { codeToScan } from './keymap.ts';

type InjectWireEvent =
  | { i: 'pmove'; x: number; y: number }
  | { i: 'pdown'; x: number; y: number; b: 0 | 1 | 2 }
  | { i: 'pup'; x: number; y: number; b: 0 | 1 | 2 }
  | { i: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { i: 'key'; sc: number; ext: boolean; down: boolean }
  | { i: 'text'; text: string };

export class InjectLink {
  private ws: WebSocket | null = null;
  private ready = false;
  private enabled = false;

  constructor(
    private readonly getToken: () => string | null,
    private readonly log: (s: string) => void,
  ) {}

  /** Connect the localhost injection channel and authenticate. Resolves availability. */
  probe(): Promise<boolean> {
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
        ws = new WebSocket(`ws://127.0.0.1:${location.port || '80'}/inject`);
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
        const token = this.getToken();
        if (!token) {
          clearTimeout(timeout);
          ws.close();
          done(false);
          return;
        }
        ws.send(JSON.stringify({ t: 'inject-hello', sessionToken: token }));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { t?: string };
          if (m.t === 'inject-ready') {
            clearTimeout(timeout);
            this.ready = true;
            this.log('input injection available on this PC');
            done(true);
          } else if (m.t === 'inject-error') {
            clearTimeout(timeout);
            done(false);
          }
        } catch {
          /* ignore malformed */
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        done(false);
      };
      ws.onclose = () => {
        this.ready = false;
      };
    });
  }

  get available(): boolean {
    return this.ready;
  }

  /** Runtime opt-in from the PC UI; drives the server-side gate too. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'inject-enable', enabled: on }));
    }
  }

  /** Forward one control event from the session DataChannel to the OS injector. */
  send(ev: InputEvent): void {
    if (!this.ready || !this.enabled || this.ws?.readyState !== WebSocket.OPEN) return;
    const wire = this.toWire(ev);
    if (wire) this.ws.send(JSON.stringify(wire));
  }

  private toWire(ev: InputEvent): InjectWireEvent | null {
    if (ev.i === 'key') {
      const sc = codeToScan(ev.code);
      if (!sc) return null;
      return { i: 'key', sc: sc.sc, ext: sc.ext, down: ev.down };
    }
    if (ev.i === 'nav') return null; // nav is Android-only; not injectable on the PC
    return ev;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.ready = false;
  }
}
