import { test, expect } from '@playwright/test';

/**
 * Demo mode auto-starts (TETHER_DEMO=1): the page pairs with the in-page
 * virtual device over the real broker + real Noise handshake, lands on the
 * Live screen, and receives the synthetic screen over a real (loopback) WebRTC
 * connection.
 */
test('demo pairs, verifies, and shows live video', async ({ page }) => {
  await page.goto('/');

  // Auto-navigates to the Live screen and the link pill reads verified.
  await expect(page.getByTestId('link-pill')).toContainText(/verified/i, { timeout: 25_000 });

  // The remote video decodes real, full-size frames from the synthetic desktop.
  const video = page.getByTestId('remote-video');
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(320);

  // On one machine the media path connects host-to-host.
  await expect(page.getByTestId('stat-candidate')).toContainText(/host/i, { timeout: 20_000 });
});

test('ending the session returns to Devices with the demo peer listed', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('link-pill')).toContainText(/verified/i, { timeout: 25_000 });

  await page.getByTestId('end-session').click(); // opens the confirm modal
  await page.getByRole('dialog').getByRole('button', { name: 'End session' }).click();

  await expect(page).toHaveURL(/#\/devices/, { timeout: 10_000 });
  await expect(page.getByText('Demo PC (virtual)')).toBeVisible();
});
