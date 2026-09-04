/**
 * Process supervisor for the go-ios pipeline. Each ManagedProcess is a spawned
 * command with a ring buffer of recent log lines and a readiness signal
 * (either a stdout pattern or an async probe). The Orchestrator runs the
 * ordered steps that bring WebDriverAgent up over USB and keeps the long-lived
 * ones alive.
 *
 * The exact go-ios invocations (iOS 26, the maintainer's supported path as of
 * Aug 2026) are documented in docs/IOS-CONTROL.md. Commands are injectable so
 * the tests can drive fakes instead of a real device.
 */

import { spawn, type ChildProcess } from 'node:child_process';

export type ProcState = 'stopped' | 'starting' | 'running' | 'failed' | 'stopping';

export interface Spawner {
  (cmd: string, args: string[]): ChildProcess;
}

const defaultSpawn: Spawner = (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

export interface ManagedProcessOpts {
  name: string;
  cmd: string;
  args: string[];
  /** Long-lived (kept running) vs one-shot (runs to completion). */
  longLived: boolean;
  /** Ready when a stdout/stderr line matches this. */
  readyPattern?: RegExp;
  /** Ready when this async probe resolves true (polled). */
  readyProbe?: () => Promise<boolean>;
  spawner?: Spawner;
}

export class ManagedProcess {
  state: ProcState = 'stopped';
  readonly logs: string[] = [];
  private child: ChildProcess | null = null;
  private readonly listeners = new Set<(p: ManagedProcess) => void>();

  private readonly opts: ManagedProcessOpts;

  constructor(opts: ManagedProcessOpts) {
    this.opts = opts;
  }

  get name(): string {
    return this.opts.name;
  }

  onChange(fn: (p: ManagedProcess) => void): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this);
  }

  private log(line: string): void {
    for (const l of line.split('\n')) {
      if (!l.trim()) continue;
      this.logs.push(l);
      if (this.logs.length > 500) this.logs.shift();
    }
    this.emit();
  }

  private setState(s: ProcState): void {
    this.state = s;
    this.emit();
  }

  /** Start and resolve once ready (pattern matched, probe true, or one-shot exit 0). */
  start(readyTimeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('starting');
      const spawner = this.opts.spawner ?? defaultSpawn;
      const child = spawner(this.opts.cmd, this.opts.args);
      this.child = child;
      let settled = false;
      const done = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      const ready = () => {
        this.setState('running');
        done(resolve);
      };

      child.stdout?.on('data', (b: Buffer) => {
        const s = b.toString();
        this.log(s);
        if (this.opts.readyPattern?.test(s)) ready();
      });
      child.stderr?.on('data', (b: Buffer) => {
        const s = b.toString();
        this.log(s);
        if (this.opts.readyPattern?.test(s)) ready();
      });
      child.on('error', (e) => {
        this.log(`spawn error: ${e.message}`);
        this.setState('failed');
        done(() => reject(e));
      });
      child.on('exit', (code) => {
        this.log(`exited (code ${code})`);
        if (this.opts.longLived) {
          this.setState('failed');
          done(() => reject(new Error(`${this.opts.name} exited early (code ${code})`)));
        } else {
          this.setState(code === 0 ? 'running' : 'failed');
          done(() => (code === 0 ? resolve() : reject(new Error(`${this.opts.name} exited ${code}`))));
        }
      });

      if (this.opts.readyProbe) {
        const t0 = Date.now();
        const poll = async () => {
          if (settled) return;
          if (await this.opts.readyProbe!().catch(() => false)) return ready();
          if (Date.now() - t0 > readyTimeoutMs) return done(() => reject(new Error(`${this.opts.name} not ready in time`)));
          setTimeout(poll, 500);
        };
        void poll();
      } else if (!this.opts.readyPattern && this.opts.longLived) {
        // No readiness signal: consider it ready shortly after spawn.
        setTimeout(ready, 300);
      }
    });
  }

  stop(): void {
    if (!this.child) return;
    this.setState('stopping');
    try {
      if (process.platform === 'win32' && this.child.pid) spawn('taskkill', ['/pid', String(this.child.pid), '/T', '/F']);
      else this.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    this.child = null;
    this.setState('stopped');
  }
}

export interface OrchestratorOpts {
  iosBin: string;
  wdaBundleId: string;
  xctestConfig: string;
  spawner?: Spawner;
  wdaReady: () => Promise<boolean>;
}

/** Brings WDA up in order, then keeps the long-lived steps alive. */
export class Orchestrator {
  readonly steps: ManagedProcess[] = [];
  private stopping = false;

  private readonly opts: OrchestratorOpts;

  constructor(opts: OrchestratorOpts) {
    this.opts = opts;
  }

  private mk(o: Omit<ManagedProcessOpts, 'spawner'>): ManagedProcess {
    const p = new ManagedProcess({ ...o, spawner: this.opts.spawner });
    this.steps.push(p);
    return p;
  }

  onChange(fn: (p: ManagedProcess) => void): void {
    for (const s of this.steps) s.onChange(fn);
  }

  /** Define the pipeline. Kept separate from run() so tests can inspect it. */
  plan(): void {
    const ios = this.opts.iosBin;
    this.mk({ name: 'tunnel', cmd: ios, args: ['tunnel', 'start', '--userspace'], longLived: true, readyPattern: /Tunnel established|ReadyToAcceptConnections|tunnel.*started/i });
    this.mk({ name: 'image', cmd: ios, args: ['image', 'auto'], longLived: false });
    this.mk({ name: 'forward-wda', cmd: ios, args: ['forward', '8100', '8100'], longLived: true });
    this.mk({ name: 'forward-mjpeg', cmd: ios, args: ['forward', '9100', '9100'], longLived: true });
    this.mk({
      name: 'runwda',
      cmd: ios,
      args: ['runwda', `--bundleid=${this.opts.wdaBundleId}`, `--testrunnerbundleid=${this.opts.wdaBundleId}`, `--xctestconfig=${this.opts.xctestConfig}`],
      longLived: true,
      readyProbe: this.opts.wdaReady,
    });
  }

  async run(onStep?: (p: ManagedProcess) => void): Promise<void> {
    if (this.steps.length === 0) this.plan();
    if (onStep) this.onChange(onStep);
    for (const step of this.steps) {
      if (this.stopping) return;
      await step.start();
    }
  }

  stopAll(): void {
    this.stopping = true;
    for (const s of [...this.steps].reverse()) s.stop();
  }
}
