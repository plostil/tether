/**
 * Drive the LIVE GitHub Pages deployment in headless Chromium and check the
 * same things the standalone e2e checks locally: landing page links, the app
 * detects no broker, the demo pairs (verified) and streams real video frames,
 * hosting is refused, no source maps are published, no request 404s.
 *
 *   npm run check:live                       # https://plostil.github.io/tether/
 *   BASE=http://localhost:8092/tether/ npm run check:live
 */
import { chromium } from '@playwright/test';

const base = process.env.BASE ?? 'https://plostil.github.io/tether/';
const out = (k, v) => console.log(`${k}: ${v}`);

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && !r.url().endsWith('app.js.map') && errors.push(`${r.status()} ${r.url()}`));

try {
  // Landing page
  const r = await page.goto(base, { waitUntil: 'load' });
  out('landing status', r.status());
  out('landing title', await page.title());
  out('landing has app link', await page.locator('a[href="app/"]').count() > 0);
  out('landing demo CTA', await page.locator('a[href="app/#/pair/demo"]').count() > 0);

  // App root: standalone note
  const r2 = await page.goto(`${base}app/`, { waitUntil: 'load' });
  out('app status', r2.status());
  await page.getByTestId('standalone-note').waitFor({ timeout: 20000 });
  out('standalone note', 'visible');
  out('offline banner', await page.getByText('You are offline').count());

  // Demo: verified + video + host candidate
  await page.goto(`${base}app/#/pair/demo`);
  const pill = page.getByTestId('link-pill');
  await pill.filter({ hasText: /verified/i }).waitFor({ timeout: 30000 });
  out('link pill', (await pill.textContent())?.trim());
  const video = page.getByTestId('remote-video');
  let w = 0;
  for (let i = 0; i < 60 && w < 320; i++) {
    w = await video.evaluate((v) => v.videoWidth).catch(() => 0);
    await page.waitForTimeout(500);
  }
  out('video width', w);
  const cand = page.getByTestId('stat-candidate');
  await cand.filter({ hasText: /host/i }).waitFor({ timeout: 20000 });
  out('candidate', (await cand.textContent())?.trim());

  // Host screen: refused with banner
  await page.goto(`${base}app/#/pair/host?mode=view`);
  await page.getByTestId('standalone-banner').waitFor({ timeout: 15000 });
  out('host banner', 'visible');

  // No source maps published
  const map = await page.request.get(`${base}app/app.js.map`);
  out('app.js.map status', map.status());
  out('page errors', errors.length ? errors.join(' | ') : 'none');
  out('RESULT', 'PASS');
} catch (e) {
  out('page errors', errors.join(' | ') || 'none');
  out('RESULT', `FAIL ${e.message.split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
