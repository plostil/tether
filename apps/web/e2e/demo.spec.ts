import { test, expect } from '@playwright/test';

/**
 * Demo mode auto-starts (TETHER_DEMO=1). The page pairs with the in-page
 * virtual device over the real broker + real Noise handshake, then receives
 * the synthetic screen over a real (loopback) WebRTC connection.
 */
test('demo pairs, verifies, and shows live video', async ({ page }) => {
  await page.goto('/');

  // The handshake timeline reaches "verified".
  await expect(page.getByTestId('hs-step-verified')).toHaveAttribute('data-status', 'done');

  // The link pill reads verified.
  await expect(page.getByTestId('link-pill')).toContainText(/verified/i);

  // The remote video actually decodes frames.
  const video = page.getByTestId('remote-video');
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 25_000 })
    .toBeGreaterThan(0);

  // On one machine the media path is host-to-host.
  await expect(page.getByTestId('stat-candidate')).toContainText(/host|prflx/i, { timeout: 20_000 });
});
