import { test, expect } from '@playwright/test';

/**
 * The hosted build: dist/ served as static files under a sub-path, with no
 * broker at all (the GitHub Pages shape). The page must notice there is no
 * backend, fall back to the in-tab loopback transport, and the demo must
 * still run the real Noise handshake and stream live video.
 */
test.use({ baseURL: 'http://localhost:8092/tether/app/' });

test('static host: page detects no broker and says so', async ({ page }) => {
  await page.goto('./');
  await expect(page.getByTestId('standalone-note')).toBeVisible({ timeout: 15_000 });
  // No offline banner: the loopback transport registers instantly.
  await expect(page.getByText('You are offline')).toHaveCount(0);
});

test('static host: demo pairs over loopback and shows live video', async ({ page }) => {
  await page.goto('./#/pair/demo');

  await expect(page.getByTestId('link-pill')).toContainText(/verified/i, { timeout: 25_000 });

  const video = page.getByTestId('remote-video');
  await expect
    .poll(async () => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 25_000 })
    .toBeGreaterThanOrEqual(320);

  await expect(page.getByTestId('stat-candidate')).toContainText(/host/i, { timeout: 20_000 });
});

test('static host: hosting a real pairing is refused with a pointer to the demo', async ({ page }) => {
  await page.goto('./#/pair/host?mode=view');
  await expect(page.getByTestId('standalone-banner')).toBeVisible({ timeout: 15_000 });
});
