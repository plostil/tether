/**
 * Time-limited TURN credentials using the coturn `use-auth-secret` REST scheme
 * (SPEC §4: NAT traversal = ICE + STUN + our own TURN).
 *
 *   username   = "<unix-expiry>[:<userId>]"
 *   credential = base64( HMAC-SHA1( sharedSecret, username ) )
 *
 * The TURN server validates this without any per-user database: it recomputes
 * the HMAC and checks the embedded expiry. Credentials are ephemeral, so a
 * leaked one is useless after `ttlSec`.
 */

import { createHmac } from 'node:crypto';

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface IceConfig {
  iceServers: IceServer[];
  ttlSec: number;
}

export function makeTurnCredential(
  secret: string,
  ttlSec: number,
  now: () => number = () => Date.now(),
  userId?: string,
): { username: string; credential: string; expiresAt: number } {
  const expiry = Math.floor(now() / 1000) + ttlSec;
  const username = userId ? `${expiry}:${userId}` : String(expiry);
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry };
}

export function buildIceConfig(opts: {
  stunUris: string[];
  turnUris: string[];
  turnSecret: string | null;
  turnTtlSec: number;
  userId?: string;
  now?: () => number;
}): IceConfig {
  const iceServers: IceServer[] = [];
  if (opts.stunUris.length) iceServers.push({ urls: opts.stunUris });

  if (opts.turnUris.length && opts.turnSecret) {
    const cred = makeTurnCredential(opts.turnSecret, opts.turnTtlSec, opts.now, opts.userId);
    iceServers.push({
      urls: opts.turnUris,
      username: cred.username,
      credential: cred.credential,
    });
  }
  return { iceServers, ttlSec: opts.turnTtlSec };
}
