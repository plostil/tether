/** Bridge state, broadcast to the setup screen over SSE. */

import type { Prereq } from './prereqs.ts';
import type { ProcState } from './supervisor.ts';

export interface ProcView {
  name: string;
  state: ProcState;
  logTail: string[];
}

export interface BridgeSnapshot {
  phase: 'idle' | 'checking' | 'starting' | 'running' | 'failed';
  prereqs: Prereq[];
  processes: ProcView[];
  screen: { width: number; height: number } | null;
  error: string | null;
}

export class BridgeState {
  private snap: BridgeSnapshot = { phase: 'idle', prereqs: [], processes: [], screen: null, error: null };
  private readonly subs = new Set<(s: BridgeSnapshot) => void>();

  snapshot(): BridgeSnapshot {
    return this.snap;
  }

  subscribe(fn: (s: BridgeSnapshot) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  update(patch: Partial<BridgeSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.subs) fn(this.snap);
  }
}
