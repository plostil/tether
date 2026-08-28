/**
 * Bundle the web client: src/main.ts -> dist/app.js, plus public/ copied in.
 * `--platform=browser` doubles as the guard that no node:* import ever leaks
 * into the browser graph (it hard-errors instead of shimming).
 */

import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

const options = {
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(dist, 'app.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020', 'safari15'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

mkdirSync(dist, { recursive: true });
cpSync(join(root, 'public'), dist, { recursive: true });

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('[web] watching for changes…');
} else {
  await build(options);
}
