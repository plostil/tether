/** Server configuration, read from the environment with safe defaults. */
export interface ServerConfig {
  port: number;
  host: string;
  signalPath: string;
  heartbeatIntervalMs: number;
  relayRatePerSec: number;
  /** How long a session token (issued at registration) stays valid. */
  sessionTtlSec: number;
  /** ICE servers handed to clients (SPEC §4: ICE + STUN + own TURN). */
  stunUris: string[];
  turnUris: string[];
  /** coturn `use-auth-secret` shared secret for time-limited REST credentials. */
  turnSecret: string | null;
  turnTtlSec: number;
  /** Directory of static files to serve (the built web client), or null. */
  webRoot: string | null;
  /** Tell the web client to auto-start demo mode (TETHER_DEMO=1). */
  demo: boolean;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function flag(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true' || v?.toLowerCase() === 'yes';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? '0.0.0.0',
    signalPath: env.SIGNAL_PATH ?? '/signal',
    heartbeatIntervalMs: Number(env.HEARTBEAT_MS ?? 20_000),
    relayRatePerSec: Number(env.RELAY_RATE ?? 50),
    sessionTtlSec: Number(env.SESSION_TTL ?? 3600),
    stunUris: list(env.STUN_URIS).length ? list(env.STUN_URIS) : ['stun:stun.l.google.com:19302'],
    turnUris: list(env.TURN_URIS),
    turnSecret: env.TURN_SECRET ?? null,
    turnTtlSec: Number(env.TURN_TTL ?? 3600),
    webRoot: env.WEB_ROOT || null,
    demo: flag(env.TETHER_DEMO),
  };
}
