/**
 * Bridge CLI. Starts the local control API and prints the setup URL (with the
 * one-time token) for the web client's iPhone mode. Running the go-ios pipeline
 * is triggered from the setup screen (POST /iphone/start) once prerequisites
 * pass, so the operator sees the live checklist first.
 *
 *   node apps/ios-bridge/src/index.ts
 *
 * Env: BRIDGE_PORT (8090), BRIDGE_TOKEN (random if unset), IOS_BIN (ios),
 *      WDA_BUNDLE_ID (com.facebook.WebDriverAgentRunner.xctrunner),
 *      WDA_XCTEST (WebDriverAgentRunner.xctest), WEB_ORIGIN (http://localhost:8080).
 */

import { randomBytes } from 'node:crypto';
import { WdaClient, type WindowSize } from './wda.ts';
import { checkAll } from './prereqs.ts';
import { Orchestrator, type ManagedProcess } from './supervisor.ts';
import { BridgeState } from './state.ts';
import { createApi } from './api.ts';

const PORT = Number(process.env.BRIDGE_PORT ?? 8090);
const TOKEN = process.env.BRIDGE_TOKEN ?? randomBytes(12).toString('base64url');
const IOS_BIN = process.env.IOS_BIN ?? 'ios';
const WDA_BUNDLE_ID = process.env.WDA_BUNDLE_ID ?? 'com.facebook.WebDriverAgentRunner.xctrunner';
const WDA_XCTEST = process.env.WDA_XCTEST ?? 'WebDriverAgentRunner.xctest';
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8080';

const wda = new WdaClient();
const state = new BridgeState();
let windowSize: WindowSize | null = null;
let orch: Orchestrator | null = null;

const procView = (p: ManagedProcess) => ({ name: p.name, state: p.state, logTail: p.logs.slice(-8) });

async function start(): Promise<void> {
  state.update({ phase: 'checking', prereqs: checkAll(IOS_BIN, WDA_BUNDLE_ID), error: null });
  orch = new Orchestrator({ iosBin: IOS_BIN, wdaBundleId: WDA_BUNDLE_ID, xctestConfig: WDA_XCTEST, wdaReady: () => wda.status() });
  orch.plan();
  const pushProcs = () => state.update({ processes: orch!.steps.map(procView) });
  state.update({ phase: 'starting' });
  pushProcs();
  try {
    await orch.run(pushProcs);
    await wda.createSession();
    windowSize = await wda.windowSize();
    state.update({ phase: 'running', screen: windowSize });
  } catch (e) {
    state.update({ phase: 'failed', error: (e as Error).message });
    pushProcs();
  }
}

function stop(): void {
  orch?.stopAll();
  orch = null;
  windowSize = null;
  state.update({ phase: 'idle', processes: [], screen: null });
}

// Refresh the prerequisite checklist on demand even before starting.
state.update({ prereqs: checkAll(IOS_BIN, WDA_BUNDLE_ID) });

const server = createApi({ token: TOKEN, webOrigin: WEB_ORIGIN, wda, state, start, stop, windowSize: () => windowSize });
server.listen(PORT, '127.0.0.1', () => {
  const setupUrl = `${WEB_ORIGIN}/#/iphone/setup?bridge=${encodeURIComponent(`http://127.0.0.1:${PORT}`)}&token=${TOKEN}`;
  console.log(`[ios-bridge] control API on http://127.0.0.1:${PORT}  (token ${TOKEN})`);
  console.log(`[ios-bridge] open the setup screen:\n  ${setupUrl}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stop();
    server.close(() => process.exit(0));
  });
}
