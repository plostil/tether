/**
 * Drive the LIVE GitHub Pages deployment in headless Chromium and check the
 * same things the standalone e2e checks locally: landing page links, the app
 * detects no broker, the demo pairs (verified) and streams real video frames
 * over WebRTC, the demo still shows video on a network that blocks WebRTC,
 * hosting is refused, no source maps are published, no request 404s.
 *
 *   npm run check:live                       # https://plostil.github.io/tether/
 *   BASE=http://localhost:8092/tether/ npm run check:live
 */
import { chromium } from '@playwright/test';

const base = process.env.BASE ?? 'https://plostil.github.io/tether/';
const out = (k, v) => console.log(`${k}: ${v}`);

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    // Real host IPs instead of mDNS names, so the WebRTC path connects on any
    // network the check runs from (see playwright.config.ts).
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
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
  if (w < 320) throw new Error('demo video never arrived over WebRTC');
  const cand = page.getByTestId('stat-candidate');
  await cand.filter({ hasText: /host/i }).waitFor({ timeout: 20000 });
  out('candidate', (await cand.textContent())?.trim());

  // Demo on a network that blocks WebRTC: falls back to the in-tab stream
  const blocked = await browser.newPage();
  blocked.on('pageerror', (e) => errors.push(String(e)));
  await blocked.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(config) {
        super({ ...config, iceServers: [], iceTransportPolicy: 'relay' });
      }
    };
  });
  await blocked.goto(`${base}app/#/pair/demo`);
  await blocked.getByTestId('in-tab-note').waitFor({ timeout: 30000 });
  let bw = 0;
  for (let i = 0; i < 30 && bw < 320; i++) {
    bw = await blocked.getByTestId('remote-video').evaluate((v) => v.videoWidth).catch(() => 0);
    await blocked.waitForTimeout(500);
  }
  out('blocked-network fallback', `${(await blocked.getByTestId('stat-candidate').textContent())?.trim()}, video width ${bw}`);
  if (bw < 320) throw new Error('blocked-network fallback shows no video');
  await blocked.close();

  // Host screen: refused with banner
  await page.goto(`${base}app/#/pair/host?mode=view`);
  await page.getByTestId('standalone-banner').waitFor({ timeout: 15000 });
  out('host banner', 'visible');

  // App favicon is served (headless Chromium does not fetch it on its own)
  const ico = await page.request.get(`${base}app/favicon.svg`);
  out('app favicon status', ico.status());

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
