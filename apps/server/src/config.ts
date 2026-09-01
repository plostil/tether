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
  /**
   * Register the localhost-only `/inject` channel for PC input injection. When
   * true the channel exists but stays inert until the PC UI opts in at runtime.
   * Only ever reachable from loopback regardless of this flag.
   */
  injectEnabled: boolean;
  /**
   * Register the localhost-only `/ios-control` channel for driving a
   * WebDriverAgent-equipped iPhone on the LAN (docs/IOS-CONTROL.md). Like
   * `/inject`, the channel exists but stays inert until the PC UI opts in.
   */
  iosControlEnabled: boolean;
  /**
   * Which iOS-control backend `/ios-control` uses:
   *   'hid' — pymobiledevice3 universal-hid-service over the iOS 17+ tunnel; NO
   *           app installed on the iPhone (default).
   *   'wda' — WebDriverAgent over the LAN; needs WDA installed on the iPhone.
   */
  iosBackend: 'wda' | 'hid';
  /** Default WDA base URL (e.g. `http://192.168.1.42:8100`); the UI may override. */
  wdaUrl: string | null;
  /** pymobiledevice3 executable for the 'hid' backend. */
  pmd3Bin: string;
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
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
    injectEnabled: (env.INJECT ?? 'true') !== 'false',
    iosControlEnabled: (env.IOS_CONTROL ?? 'true') !== 'false',
    iosBackend: env.IOS_BACKEND === 'wda' ? 'wda' : 'hid',
    wdaUrl: env.WDA_URL || null,
    pmd3Bin: env.PMD3_BIN || 'pymobiledevice3',
  };
}
