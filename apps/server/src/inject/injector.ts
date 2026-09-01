/**
 * PC-side input injection (SPEC §2.1 remote-control, Windows `sendinput` path).
 *
 * The PC's media endpoint is a browser, which cannot inject OS input — so the
 * co-located broker does it. This module owns a single PERSISTENT PowerShell
 * child (SendInputHost.ps1) and feeds it a trivial line protocol on stdin. The
 * process is spawned lazily on the first event and restarted with backoff if it
 * dies; the Add-Type compile cost is paid once, never per event.
 *
 * Chosen over an FFI dependency (koffi) or a native addon (node-gyp): no npm
 * dependency and no C++ toolchain, matching the broker's zero-runtime-dep
 * design. Trade-off: ~0.5s cold start (hidden behind lazy spawn) and a process
 * boundary, both negligible next to human input rates.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'SendInputHost.ps1');

/**
 * Injection event as it arrives on the `/inject` channel. Pointer coords are
 * normalized 0..1 of the shared frame (as {@link import('@tether/protocol').InputEvent});
 * key events arrive PRE-MAPPED to a PC/AT scancode + extended flag by the
 * browser's keymap, so this side and the PS host stay free of any keymap.
 */
export type InjectEvent =
  | { i: 'pmove'; x: number; y: number }
  | { i: 'pdown'; x: number; y: number; b: 0 | 1 | 2 }
  | { i: 'pup'; x: number; y: number; b: 0 | 1 | 2 }
  | { i: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { i: 'key'; sc: number; ext: boolean; down: boolean }
  | { i: 'text'; text: string };

type SpawnFn = typeof spawn;

const ABS_MAX = 65535;

function clampAbs(n: number): number {
  const v = Math.round(n * ABS_MAX);
  return v < 0 ? 0 : v > ABS_MAX ? ABS_MAX : v;
}

/** Translate one injection event to a single SendInputHost.ps1 stdin line, or null to ignore. */
export function eventToLine(ev: InjectEvent): string | null {
  switch (ev.i) {
    case 'pmove':
      return `m ${clampAbs(ev.x)} ${clampAbs(ev.y)}`;
    case 'pdown':
      return `d ${ev.b}`;
    case 'pup':
      return `u ${ev.b}`;
    case 'wheel':
      // WheelEvent deltaY > 0 means scrolling down; Win32 WHEEL positive is up.
      return `w ${Math.round(-ev.dx)} ${Math.round(-ev.dy)}`;
    case 'key':
      return `k ${ev.sc & 0xffff} ${ev.down ? 1 : 0} ${ev.ext ? 1 : 0}`;
    case 'text':
      return `t ${Buffer.from(ev.text, 'utf8').toString('base64')}`;
    default:
      return null;
  }
}

export interface InjectorOptions {
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawn?: SpawnFn;
  /** Path to the PS host script; defaults to the sibling SendInputHost.ps1. */
  scriptPath?: string;
  /** Restart backoff after the child exits, ms. */
  restartDelayMs?: number;
}

export class Injector {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stopped = false;
  private restarting = false;
  private readonly spawnFn: SpawnFn;
  private readonly scriptPath: string;
  private readonly restartDelayMs: number;

  constructor(opts: InjectorOptions = {}) {
    this.spawnFn = opts.spawn ?? spawn;
    this.scriptPath = opts.scriptPath ?? HOST_SCRIPT;
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
  }

  /** Inject one event; spawns the host on first use. No-ops after close(). */
  dispatch(ev: InjectEvent): void {
    if (this.stopped) return;
    const line = eventToLine(ev);
    if (line === null) return;
    const child = this.ensureChild();
    if (child.stdin.writable) child.stdin.write(line + '\n');
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = this.spawnFn(
      'powershell.exe',
      ['-NoProfile', '-NoLogo', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath],
      { windowsHide: true },
    ) as ChildProcessWithoutNullStreams;
    this.child = child;
    child.on('exit', () => {
      this.child = null;
      if (!this.stopped && !this.restarting) {
        this.restarting = true;
        setTimeout(() => {
          this.restarting = false;
        }, this.restartDelayMs).unref?.();
      }
    });
    child.on('error', () => {
      this.child = null;
    });
    return child;
  }

  /** Terminate the host process and stop accepting events. */
  close(): void {
    this.stopped = true;
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
}
