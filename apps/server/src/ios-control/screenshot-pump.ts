/**
 * Low-fps screenshot pump: polls WDA's `GET /screenshot` and emits base64 PNG
 * frames to the PC UI. This is v1's iPhone-screen *view* — crude but enough for
 * click-targeting, and it needs nothing beyond WDA itself (no ReplayKit/WebRTC
 * pipeline, no Mac). Smooth mirroring is the deferred ReplayKit upgrade.
 *
 * The loop reschedules only after each capture settles, so a slow or hung WDA
 * can never pile up overlapping requests.
 */

export interface ScreenshotPumpOptions {
  /** Returns the next base64 PNG, or null to skip this tick (not ready). */
  capture: () => Promise<string | null>;
  /** Receives each captured frame. */
  onFrame: (base64Png: string) => void;
  /** Frames per second; defaults to 3. */
  fps?: number;
}

export class ScreenshotPump {
  private readonly capture: () => Promise<string | null>;
  private readonly onFrame: (b64: string) => void;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(opts: ScreenshotPumpOptions) {
    this.capture = opts.capture;
    this.onFrame = opts.onFrame;
    this.intervalMs = Math.max(50, Math.round(1000 / (opts.fps ?? 3)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    if (!this.running) return;
    this.capture()
      .then((frame) => {
        if (frame && this.running) this.onFrame(frame);
      })
      .catch(() => {
        /* transient WDA error — controller handles recovery; just skip a frame */
      })
      .finally(() => {
        if (!this.running) return;
        this.timer = setTimeout(() => this.tick(), this.intervalMs);
        this.timer.unref?.();
      });
  }
}
