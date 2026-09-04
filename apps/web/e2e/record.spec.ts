import { test } from '@playwright/test';

/**
 * Recording driver (not an assertion test). The record project's server runs
 * with TETHER_DEMO=1, so the app auto-starts the demo and lands on the live
 * view; this captures the connecting → verified → streaming transition and
 * lingers so the clip shows the synthetic desktop moving. Produces a webm
 * under test-results; convert to docs/demo.gif per docs/DEMO.md.
 */
test('record the demo', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid=remote-video]') as HTMLVideoElement | null;
    return !!v && v.videoWidth >= 320;
  }, undefined, { timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(7000); // hold on the live, streaming view
});
