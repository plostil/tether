/**
 * No-install PC → iPhone control via pymobiledevice3's universal-hid-service
 * (docs/IOS-CONTROL.md). Injects real taps/drags over Apple's iOS 17+ developer
 * tunnel — nothing is installed on the iPhone (only Trust + Developer Mode).
 *
 * Same shape as the Windows injector (apps/server/src/inject/injector.ts): a
 * PERSISTENT child process fed a trivial line protocol on stdin, restarted with
 * backoff. Here the child is `pymobiledevice3 ... universal-hid-service session`,
 * which reads gesture lines (`tap X Y`, `drag X1 Y1 X2 Y2`, `sleep MS`) in the
 * HID absolute 0..65535 space (center = 32768) — so tether's normalized 0..1
 * InputEvent maps by ×65535, exactly like the Windows SendInput path.
 *
 * Prerequisite (admin, once per boot; scripts/ios-tunnel.ps1): the RSD tunnel
 * daemon + a mounted Developer Disk Image. Commands here auto-discover the
 * device via `--tunnel ''`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InputEvent } from '@tether/protocol';
import type { IosControlBackend, IosStatus } from './backend.ts';

type SpawnFn = typeof spawn;

const ABS_MAX = 65535;

function clampAbs(n: number): number {
  const v = Math.round(n * ABS_MAX);
  return v < 0 ? 0 : v > ABS_MAX ? ABS_MAX : v;
}

/** Gesture-line helpers (pure; unit-tested). */
export function tapLine(x: number, y: number): string {
  return `tap ${clampAbs(x)} ${clampAbs(y)}`;
}
export function dragLine(x1: number, y1: number, x2: number, y2: number): string {
  return `drag ${clampAbs(x1)} ${clampAbs(y1)} ${clampAbs(x2)} ${clampAbs(y2)}`;
}

export interface HidTunnelOptions {
  /** pymobiledevice3 executable; defaults to `pymobiledevice3` on PATH. */
  pmd3Bin?: string;
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawn?: SpawnFn;
  /** Wall clock in ms; injectable for tests. */
  now?: () => number;
  /** Tap vs drag threshold, as a fraction of the 0..65535 space. */
  tapSlopFrac?: number;
  /** A press held longer than this (with little movement) still counts as a tap. */
  tapMaxMs?: number;
  /** Reconnect backoff after a failure, ms. */
  reconnectDelayMs?: number;
}

export class HidTunnelController implements IosControlBackend {
  private readonly bin: string;
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly tapSlopFrac: number;
  private readonly tapMaxMs: number;
  private readonly reconnectDelayMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private closed = false;
  private reconnecting = false;
  private statusListener: ((s: IosStatus, message?: string) => void) | null = null;

  // Pointer-gesture accumulation, in HID 0..65535 coords (normalized until write).
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private downAt = 0;
  private pressed = false;

  constructor(opts: HidTunnelOptions = {}) {
    this.bin = opts.pmd3Bin ?? 'pymobiledevice3';
    this.spawnFn = opts.spawn ?? spawn;
    this.now = opts.now ?? Date.now;
    this.tapSlopFrac = opts.tapSlopFrac ?? 0.02;
    this.tapMaxMs = opts.tapMaxMs ?? 400;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 2000;
  }

  setStatusListener(fn: ((s: IosStatus, message?: string) => void) | null): void {
    this.statusListener = fn;
  }

  isReady(): boolean {
    return this.ready && this.child !== null;
  }

  /** Verify the device/tunnel is reachable, then start the persistent session. */
  async connect(_target?: string): Promise<void> {
    this.closed = false;
    await this.attempt();
  }

  dispatch(ev: InputEvent): void {
    if (!this.isReady()) return;
    switch (ev.i) {
      case 'pdown':
        this.downX = this.lastX = ev.x;
        this.downY = this.lastY = ev.y;
        this.downAt = this.now();
        this.pressed = true;
        break;
      case 'pmove':
        if (this.pressed) {
          this.lastX = ev.x;
          this.lastY = ev.y;
        }
        break;
      case 'pup': {
        if (!this.pressed) break;
        this.pressed = false;
        this.lastX = ev.x;
        this.lastY = ev.y;
        this.dispatchGesture();
        break;
      }
      case 'wheel': {
        // A short centered contact drag; content scrolls opposite the wheel sign.
        const throwFrac = ev.dy > 0 ? -0.25 : 0.25;
        this.write(dragLine(0.5, 0.5, 0.5, clamp01(0.5 + throwFrac)));
        break;
      }
      // 'text' has no app-free keyboard path in universal-hid-service (v1: use the
      // WDA backend for typing); 'key'/'nav' are dropped as elsewhere.
    }
  }

  async screenshot(): Promise<string | null> {
    if (this.closed) return null;
    const path = join(tmpdir(), `tether-ios-${process.pid}-${this.now()}.png`);
    try {
      const { code } = await this.runOnce(['developer', 'dvt', 'screenshot', path]);
      if (code !== 0) throw new Error('screenshot failed');
      const buf = await readFile(path);
      return buf.toString('base64');
    } catch (err) {
      this.onFailure(err);
      return null;
    } finally {
      void rm(path, { force: true }).catch(() => {});
    }
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    this.pressed = false;
    this.killChild();
  }

  private async attempt(): Promise<void> {
    if (this.closed) return;
    this.emit('connecting');
    let ok = false;
    try {
      const { code } = await this.runOnce(['developer', 'core-device', 'get-display-info']);
      ok = code === 0;
    } catch {
      ok = false;
    }
    if (this.closed) return;
    if (!ok) {
      this.emit('unreachable', 'iPhone/tunnel not reachable — connect the device, enable Developer Mode, and run the tunnel');
      this.scheduleReconnect();
      return;
    }
    this.startSession();
    this.ready = true;
    this.emit('ready');
  }

  private startSession(): void {
    this.killChild();
    const child = this.spawnChild(['developer', 'core-device', 'universal-hid-service', 'session']);
    this.child = child;
    child.on('exit', () => {
      this.child = null;
      if (this.closed) return;
      this.ready = false;
      this.emit('unreachable', 'HID session ended');
      this.scheduleReconnect();
    });
    child.on('error', () => {
      this.child = null;
      this.ready = false;
    });
  }

  private dispatchGesture(): void {
    const dist = Math.hypot(this.lastX - this.downX, this.lastY - this.downY);
    const held = this.now() - this.downAt;
    if (dist < this.tapSlopFrac && held < this.tapMaxMs) {
      this.write(tapLine(this.downX, this.downY));
    } else {
      this.write(dragLine(this.downX, this.downY, this.lastX, this.lastY));
    }
  }

  private write(line: string): void {
    const child = this.child;
    if (child && child.stdin.writable) child.stdin.write(line + '\n');
  }

  /** Spawn a persistent child with the tunnel-autodiscovery flag. */
  private spawnChild(args: string[]): ChildProcessWithoutNullStreams {
    return this.spawnFn(this.bin, [...args, '--tunnel', ''], {
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
  }

  /** Run a short-lived command to completion, collecting the exit code. */
  private runOnce(args: string[]): Promise<{ code: number | null }> {
    return new Promise((resolve) => {
      const child = this.spawnChild(args);
      child.on('error', () => resolve({ code: -1 }));
      child.on('exit', (code) => resolve({ code }));
    });
  }

  private onFailure(err: unknown): void {
    if (this.closed) return;
    this.ready = false;
    this.emit('unreachable', err instanceof Error ? err.message : String(err));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnecting || this.closed) return;
    this.reconnecting = true;
    setTimeout(() => {
      this.reconnecting = false;
      if (!this.closed) void this.attempt();
    }, this.reconnectDelayMs).unref?.();
  }

  private killChild(): void {
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* already gone */
      }
      this.child.kill();
      this.child = null;
    }
  }

  private emit(s: IosStatus, message?: string): void {
    this.statusListener?.(s, message);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
