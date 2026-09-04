/** Persisted, per-origin user settings. */

export type Theme = 'system' | 'dark' | 'light';

export interface Settings {
  deviceName: string;
  theme: Theme;
  brokerUrl: string; // '' = same-origin default
  demoPref: boolean;
}

const KEY = 'tether-settings-v1';

const DEFAULTS: Settings = { deviceName: '', theme: 'system', brokerUrl: '', demoPref: false };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

/** A default device name derived from the platform, when the user set none. */
export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'My iPhone';
  if (/Android/.test(ua)) return 'My Android';
  if (/Windows/.test(ua)) return 'My Windows PC';
  if (/Mac OS X/.test(ua)) return 'My Mac';
  return 'My device';
}
