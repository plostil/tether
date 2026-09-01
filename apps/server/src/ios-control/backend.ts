/**
 * Backend seam for the `/ios-control` subsystem. Everything above it (the
 * `/ios-control` channel and the screenshot pump) talks to this interface, so
 * the actual iOS driver is swappable:
 *   - WdaController (apps/server/src/ios-control/controller.ts): WebDriverAgent
 *     over the LAN — needs an app installed on the iPhone.
 *   - HidTunnelController (hid-tunnel-controller.ts): pymobiledevice3's
 *     universal-hid-service over Apple's iOS 17+ developer tunnel — no app
 *     installed on the iPhone (docs/IOS-CONTROL.md).
 *
 * Both are host-tethered, owner-operated subsystems; neither is a tether peer,
 * so neither touches the broker / Noise / negotiateSession.
 */

import type { InputEvent } from '@tether/protocol';

export type IosStatus = 'ready' | 'connecting' | 'unreachable';

export interface IosControlBackend {
  /** The active channel registers here so mid-session status reaches the UI. */
  setStatusListener(fn: ((s: IosStatus, message?: string) => void) | null): void;
  /**
   * Establish the driver session. `target` is backend-specific: a WDA base URL
   * for the WDA backend, unused (device auto-discovered) for the HID backend.
   */
  connect(target?: string): Promise<void>;
  /** Feed one normalized input event (fire-and-forget, with failure recovery). */
  dispatch(ev: InputEvent): void;
  /** Current base64 PNG of the iPhone screen, or null when not ready. */
  screenshot(): Promise<string | null>;
  /** Stop accepting events and drop the session. */
  close(): void;
}
