/** Spin up the in-page virtual device and pair the page with it. */

import { FakeDesktop } from '../demo/fake-desktop.ts';
import { VirtualDevice, DEMO_DEVICE_NAME } from '../demo/virtual-device.ts';
import type { AppContext } from './context.ts';

let current: VirtualDevice | null = null;

export async function launchDemo(ctx: AppContext): Promise<void> {
  stopDemo();
  const desktop = new FakeDesktop();
  const virtual = new VirtualDevice(ctx.serverUrl, desktop);
  current = virtual;
  await virtual.start();
  ctx.session.start({
    role: 'initiator',
    peer: virtual.pairBlob,
    mode: 'view',
    label: DEMO_DEVICE_NAME,
    verifiedBy: 'demo',
    demo: true,
  });
  ctx.router.navigate('/live');
}

export function stopDemo(): void {
  current?.stop();
  current = null;
}
