/**
 * What THIS browser advertises it can do, as a function of the chosen mode.
 * Sent in the `register` message (opaque to the broker) and in the `hello`
 * message over the Noise channel, so the peer can gate a session with
 * negotiateSession() before answering.
 */

import type { DeviceCapabilities, Platform } from '@tether/protocol/browser';

export type Mode = 'view' | 'share' | 'control' | 'iphone' | 'text';

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Mac OS X/.test(ua)) return 'macos';
  return 'linux';
}

export const canShareScreen = typeof navigator.mediaDevices?.getDisplayMedia === 'function' && isSecureContext;

/** Capability profile for this browser page in a given mode. */
export function browserCapabilities(mode: Mode | null): DeviceCapabilities {
  const platform = detectPlatform();
  // In iPhone mode this PC proxies a USB-attached iPhone: it can be viewed (the
  // MJPEG screen re-shared over WebRTC) and controlled ('wda', input forwarded
  // to the bridge). Otherwise a browser page cannot be controlled (no injection
  // API) and can only be viewed when it can actually capture a screen.
  const iphone = mode === 'iphone';
  return {
    platform,
    remoteView: {
      canBeViewed: iphone || (canShareScreen && (mode === 'share' || mode === null)),
      canView: true,
      unattended: false,
    },
    remoteControl: { controllableVia: iphone ? 'wda' : 'none', canControlPeer: true },
    audioRouting: {
      canExportMediaAudio: false,
      canPresentVirtualDevice: false,
      canSplitDuplexLoop: false,
    },
    callHandoff: { method: 'none', canActAsHfpUnit: false },
  };
}

/** The in-page virtual device presents as a Windows PC that can be viewed. */
export const VIRTUAL_DEVICE_CAPS: DeviceCapabilities = {
  platform: 'windows',
  remoteView: { canBeViewed: true, canView: true, unattended: true },
  remoteControl: { controllableVia: 'sendinput', canControlPeer: true },
  audioRouting: {
    canExportMediaAudio: true,
    canPresentVirtualDevice: false,
    canSplitDuplexLoop: false,
  },
  callHandoff: { method: 'none', canActAsHfpUnit: false },
};
