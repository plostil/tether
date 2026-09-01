/**
 * `/inject` WebSocket handler — the localhost-only bridge from the PC's browser
 * to OS input injection. Deliberately SEPARATE from the broker's zero-trust
 * relay: the broker still parses nothing new (messages.ts invariant); this is a
 * co-located, machine-local concern.
 *
 * Reachability is restricted three independent ways:
 *   1. Localhost only — the peer address must be loopback.
 *   2. Auth — the first frame must be {t:'inject-hello', sessionToken}, and the
 *      token must validate against a live registration (same check as /ice).
 *   3. Runtime opt-in — injection is inert until the PC UI sends
 *      {t:'inject-enable', enabled:true}. Default OFF, so a connected-but-not-
 *      toggled session can move nothing.
 */

import type { IncomingMessage } from 'node:http';
import type { Broker } from '../broker.ts';
import type { WsConnection, WsHandlers, WsPathHandler } from '../ws.ts';
import { type InjectEvent, Injector } from './injector.ts';

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function send(conn: WsConnection, msg: unknown): void {
  // WsConnection.send is typed for ServerMessage; /inject uses its own shapes.
  conn.sendJson(msg);
}

/** Build the `/inject` path handler bound to a shared injector. */
export function injectWsHandler(broker: Broker, injector: Injector): WsPathHandler {
  return (conn: WsConnection, req: IncomingMessage): WsHandlers => {
    // (1) Localhost only. We reject after the 101 by closing immediately; no
    // event is ever processed on a non-loopback socket.
    if (!isLoopback(req.socket.remoteAddress)) {
      send(conn, { t: 'inject-error', message: 'forbidden: injection is localhost-only' });
      conn.close(1008, 'localhost only');
      return { onText: () => {}, onClose: () => {} };
    }

    let authed = false;
    let enabled = false;

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

        // (2) Auth handshake must come first.
        if (!authed) {
          if (
            m.t === 'inject-hello' &&
            typeof m.sessionToken === 'string' &&
            broker.validateSession(m.sessionToken)
          ) {
            authed = true;
            send(conn, { t: 'inject-ready' });
          } else {
            send(conn, { t: 'inject-error', message: 'unauthorized' });
            conn.close(1008, 'unauthorized');
          }
          return;
        }

        // (3) Live opt-in toggle from the PC UI.
        if (m.t === 'inject-enable') {
          enabled = m.enabled === true;
          return;
        }

        // Everything else is an injection event — dropped unless enabled.
        if (!enabled) return;
        if (typeof m.i === 'string') injector.dispatch(m as InjectEvent);
      },
      onClose: () => {
        enabled = false;
      },
    };
  };
}
