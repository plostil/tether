import { defineConfig, devices } from '@playwright/test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * E2E for demo mode: boot the one-command dev server with TETHER_DEMO=1 and
 * drive the real page in Chromium. The whole pipeline runs — identity, broker,
 * Noise handshake, and a loopback WebRTC connection carrying the synthetic
 * canvas — so this is the smoke alarm that the demo actually works end to end.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:8091',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'record',
      testMatch: /record.spec.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 860 },
        video: { mode: 'on', size: { width: 1280, height: 860 } },
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
    {
      name: 'chromium',
      testIgnore: /record.spec.ts/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: {
    command: 'node ../../scripts/dev.mjs --no-open',
    cwd: here,
    url: 'http://localhost:8091/health',
    timeout: 60_000,
    reuseExistingServer: false,
    env: { PORT: '8091', TETHER_DEMO: '1', CI: '1' },
  },
});
