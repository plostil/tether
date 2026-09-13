/**
 * Bundle the web client: src/app.ts -> dist/app.js (+ dist/app.css from the
 * CSS imports), plus public/ copied in. `--platform=browser` doubles as the
 * guard that no node:* import ever leaks into the browser graph (it
 * hard-errors instead of shimming).
 *
 * Exported as `buildWeb()` so scripts/dev.mjs (the one-command entry) and the
 * Playwright web server can call it in-process; still runnable as a CLI.
 */

import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const dist = join(root, 'dist');

/** The hosted build has no broker behind it: bake that in so the page goes
 *  straight to the loopback transport instead of probing for `config`.
 *  `TETHER_STANDALONE=1` or `--standalone`. */
const standalone = process.env.TETHER_STANDALONE === '1' || process.argv.includes('--standalone');

const options = {
  entryPoints: [join(root, 'src', 'app.ts')],
  define: { __STANDALONE__: String(standalone) },
  outdir: dist,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'safari15'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  loader: { '.css': 'css', '.svg': 'text' },
};

/** Build once, or start a watcher. Resolves once the first build is done. */
export async function buildWeb({ watch = false } = {}) {
  mkdirSync(dist, { recursive: true });
  cpSync(join(root, 'public'), dist, { recursive: true });
  if (standalone) console.log('[web] standalone build: loopback transport, no broker');
  if (watch) {
    const ctx = await context(options);
    await ctx.rebuild();
    await ctx.watch();
    console.log('[web] watching for changes…');
    return ctx;
  }
  await build(options);
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildWeb({ watch: process.argv.includes('--watch') });
}
