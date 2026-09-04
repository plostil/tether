/**
 * Prerequisite checks for the iPhone bridge. Each returns a live result the
 * setup screen renders as a checklist item with a fix hint. Nothing here
 * mutates the device; it only observes.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export interface Prereq {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
}

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
    return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } catch {
    return { ok: false, out: '' };
  }
}

export function checkAll(iosBin: string, wdaBundleId: string): Prereq[] {
  const out: Prereq[] = [];

  const ver = run(iosBin, ['--version']);
  out.push({
    id: 'go-ios',
    label: 'go-ios installed',
    ok: ver.ok,
    detail: ver.ok ? ver.out.split('\n')[0] ?? 'installed' : 'not found on PATH',
    fix: 'Install with: npm i -g go-ios (then restart the bridge).',
  });

  if (process.platform === 'win32') {
    const wintun = existsSync('C:/Windows/System32/wintun.dll');
    out.push({
      id: 'wintun',
      label: 'wintun.dll present (Windows, iOS 17+)',
      ok: wintun,
      detail: wintun ? 'C:\\Windows\\System32\\wintun.dll' : 'missing',
      fix: 'Download wintun.dll from https://git.zx2c4.com/wintun and copy it to C:\\Windows\\System32.',
    });
    const amds = run('sc', ['query', 'Apple Mobile Device Service']);
    out.push({
      id: 'apple-driver',
      label: 'Apple Mobile Device Service',
      ok: amds.ok && /RUNNING/i.test(amds.out),
      detail: amds.ok && /RUNNING/i.test(amds.out) ? 'running' : 'not running',
      fix: 'Install iTunes from apple.com (not the Microsoft Store build) so the USB driver + service are present.',
    });
  }

  const list = run(iosBin, ['list']);
  const hasDevice = list.ok && /"?[0-9a-f]{8,}/i.test(list.out);
  out.push({
    id: 'device',
    label: 'iPhone connected + trusted',
    ok: hasDevice,
    detail: hasDevice ? 'a device is visible over USB' : 'no device visible',
    fix: 'Connect the iPhone over USB and tap "Trust This Computer". Enable Settings → Privacy & Security → Developer Mode.',
  });

  const apps = run(iosBin, ['apps', '--list']);
  const wdaInstalled = apps.ok && apps.out.includes(wdaBundleId);
  out.push({
    id: 'wda',
    label: 'WebDriverAgent installed',
    ok: wdaInstalled,
    detail: wdaInstalled ? wdaBundleId : 'not installed / expired',
    fix: 'Build WDA via .github/workflows/build-wda.yml, sign+install it with Sideloadly (free Apple ID, bundle id ends .xctrunner), and re-sign weekly. See docs/IOS-CONTROL.md.',
  });

  return out;
}

export function allReady(prereqs: Prereq[]): boolean {
  return prereqs.every((p) => p.ok);
}
