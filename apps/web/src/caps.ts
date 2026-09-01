/**
 * Capability profile for THIS browser, advertised to the peer as a `peer-caps`
 * message right after pairing (see @tether/protocol session.ts). Role is
 * irrelevant — what a device can do is decided by its platform and features.
 *
 * `injectAvailable` is true only when a localhost injection channel is reachable
 * (i.e. this page runs on the PC beside the broker); that is what makes the
 * device *controllable* (`sendinput`). A phone browser cannot inject into its
 * own OS, so it advertises `controllableVia: 'none'` and stays view-only —
 * controlling a phone needs the native Android app (Phase E).
 */

import type { DeviceCapabilities, Platform } from '@tether/protocol/browser';

function guessPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macos';
  return 'linux';
}

export function canShareScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

export function canShareCamera(): boolean {
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

export function localCaps(injectAvailable: boolean): DeviceCapabilities {
  return {
    platform: guessPlatform(),
    remoteView: {
      canBeViewed: canShareScreen() || canShareCamera(),
      canView: true,
      unattended: false,
    },
    remoteControl: {
      controllableVia: injectAvailable ? 'sendinput' : 'none',
      canControlPeer: true,
    },
    audioRouting: {
      canExportMediaAudio: false,
      canPresentVirtualDevice: false,
      canSplitDuplexLoop: false,
    },
    callHandoff: { method: 'none', canActAsHfpUnit: false },
  };
}
