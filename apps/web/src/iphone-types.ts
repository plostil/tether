/** Shape of the bridge's status snapshot (mirrors apps/ios-bridge/src/state.ts). */
export interface BridgePrereq {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
}
export interface BridgeProc {
  name: string;
  state: 'stopped' | 'starting' | 'running' | 'failed' | 'stopping';
  logTail: string[];
}
export interface BridgeSnapshot {
  phase: 'idle' | 'checking' | 'starting' | 'running' | 'failed';
  prereqs: BridgePrereq[];
  processes: BridgeProc[];
  screen: { width: number; height: number } | null;
  error: string | null;
}
