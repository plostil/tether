/**
 * `/ios-control` WebSocket handler — the localhost-only bridge from the PC's
 * browser to a WebDriverAgent-equipped iPhone on the LAN. A deliberate twin of
 * `apps/server/src/inject/channel.ts`: the broker still parses nothing new, and
 * reachability is restricted the same three independent ways:
 *   1. Localhost only — the peer address must be loopback.
 *   2. Auth — the first frame must be {t:'ios-hello', sessionToken, wdaUrl?},
 *      the token validating against a live registration (same check as /ice).
 *   3. Runtime opt-in — control is inert until {t:'ios-enable', enabled:true}.
 *      Default OFF, so a connected-but-not-toggled session moves nothing.
 *
 * The screenshot *view* starts as soon as the WDA session connects (so the user
 * can see what they'd control); only *control* is gated by the opt-in toggle.
 */

import type { IncomingMessage } from 'node:http';
import { parseInputEvent } from '@tether/protocol';
import type { Broker } from '../broker.ts';
import type { WsConnection, WsHandlers, WsPathHandler } from '../ws.ts';
import type { IosControlBackend } from './backend.ts';
import { ScreenshotPump } from './screenshot-pump.ts';

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/** Build the `/ios-control` path handler bound to a shared controller. */
export function iosControlWsHandler(
  broker: Broker,
  controller: IosControlBackend,
  defaultWdaUrl: string | null = null,
  backend: 'wda' | 'hid' = 'wda',
): WsPathHandler {
  return (conn: WsConnection, req: IncomingMessage): WsHandlers => {
    // (1) Localhost only.
    if (!isLoopback(req.socket.remoteAddress)) {
      conn.sendJson({ t: 'ios-status', status: 'unreachable', message: 'ios-control is localhost-only' });
      conn.close(1008, 'localhost only');
      return { onText: () => {}, onClose: () => {} };
    }

    let authed = false;
    let enabled = false;
    let pump: ScreenshotPump | null = null;

    const teardown = (): void => {
      enabled = false;
      pump?.stop();
      pump = null;
      controller.setStatusListener(null);
    };

    return {
      onText: (text) => {
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof msg !== 'object' || msg === null) return;
        const m = msg as Record<string, unknown>;

        // (2) Auth handshake must come first, and it names the WDA target.
        if (!authed) {
          if (
            m.t === 'ios-hello' &&
            typeof m.sessionToken === 'string' &&
            broker.validateSession(m.sessionToken)
          ) {
            authed = true;
            conn.sendJson({ t: 'ios-info', backend });
            const url = typeof m.wdaUrl === 'string' && m.wdaUrl ? m.wdaUrl : defaultWdaUrl;
            // The HID backend auto-discovers the device over the tunnel and needs
            // no target; only the WDA backend requires a URL.
            if (backend === 'wda' && !url) {
              conn.sendJson({ t: 'ios-status', status: 'unreachable', message: 'no WDA URL configured' });
              return;
            }
            controller.setStatusListener((status, message) => {
              conn.sendJson({ t: 'ios-status', status, message });
            });
            // The pump runs from now on; screenshot() returns null until the
            // backend is ready, so it simply idles (and survives a backend that
            // self-reconnects) rather than being tied to this connect() call.
            pump = new ScreenshotPump({
              capture: () => controller.screenshot(),
              onFrame: (png) => conn.sendJson({ t: 'ios-frame', png }),
            });
            pump.start();
            controller.connect(url ?? undefined).catch(() => {
              // connect() surfaces failure through the status listener.
            });
          } else {
            conn.sendJson({ t: 'ios-status', status: 'unreachable', message: 'unauthorized' });
            conn.close(1008, 'unauthorized');
          }
          return;
        }

        // (3) Live opt-in toggle from the PC UI.
        if (m.t === 'ios-enable') {
          enabled = m.enabled === true;
          return;
        }

        // Everything else is an input event — dropped unless control is enabled.
        if (!enabled) return;
        const ev = parseInputEvent(m);
        if (ev) controller.dispatch(ev);
      },
      onClose: teardown,
    };
  };
}
