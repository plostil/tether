/**
 * Capability model — a direct encoding of the feasibility verdicts in SPEC §2.
 *
 * Each device advertises what it can actually do on its platform, and a session
 * is only allowed to request a capability both peers advertise. The point of
 * modelling this explicitly is that the constraints are load-bearing: a phone
 * that cannot be controlled (iOS) or a session that tries to split mic/speaker
 * (blocked, SPEC §2.2) must be rejected at negotiation time, not discovered at
 * runtime.
 */

export type Platform = 'android' | 'windows' | 'ios' | 'macos' | 'linux';

/** How PC->device input injection is achieved, if at all (SPEC §2.1). */
export type ControlMethod =
  | 'accessibility' // Android AccessibilityService — attended, policy-gated, AAPM-eroded
  | 'sendinput' // Windows SendInput from uiAccess helper
  | 'wda' // iOS via a USB-attached WebDriverAgent bridge (attended, dev-signed; see apps/ios-bridge)
  | 'none'; // no sanctioned injection path exists

/** How a live call can be moved between devices (SPEC §2.3). */
export type CallHandoffMethod =
  | 'own-voip' // re-negotiate the app's own VoIP media path
  | 'os-bluetooth-hfp' // ride the OS Bluetooth HFP stack; app never touches PCM
  | 'none';

export interface RemoteViewCaps {
  /** Can this device export its screen to a peer? */
  canBeViewed: boolean;
  /** Can this device render a peer's screen? */
  canView: boolean;
  /**
   * True only where capture survives without a foreground user (SPEC §2.1).
   * Android MediaProjection dies on screen lock -> always false there.
   */
  unattended: boolean;
}

export interface RemoteControlCaps {
  /** Can a peer inject input into this device, and how? */
  controllableVia: ControlMethod;
  /** Can this device drive a peer it is viewing? */
  canControlPeer: boolean;
}

export interface AudioRoutingCaps {
  /** Capture this device's media/output audio and send it to a peer. */
  canExportMediaAudio: boolean;
  /**
   * Present a peer's audio as a virtual mic/speaker to *other* local apps.
   * Requires a signed kernel driver on Windows; unavailable to a non-priv
   * Android app (SPEC §2.2). Kept explicit so we never assume it.
   */
  canPresentVirtualDevice: boolean;
  /**
   * Split the acoustic loop across devices during a full-duplex call.
   * BLOCKED in v1 (distributed AEC, SPEC §2.2). Present so the negotiator can
   * hard-reject it; expected to be false on every platform for now.
   */
  canSplitDuplexLoop: boolean;
}

export interface CallHandoffCaps {
  method: CallHandoffMethod;
  /** Cellular call handoff needs the peer to be OS-pairable as an HFP unit. */
  canActAsHfpUnit: boolean;
}

export interface DeviceCapabilities {
  platform: Platform;
  remoteView: RemoteViewCaps;
  remoteControl: RemoteControlCaps;
  audioRouting: AudioRoutingCaps;
  callHandoff: CallHandoffCaps;
}

/** Capability profile for a stock Android phone client (SPEC §2). */
export const ANDROID_STOCK_CAPS: DeviceCapabilities = {
  platform: 'android',
  remoteView: { canBeViewed: true, canView: true, unattended: false },
  remoteControl: { controllableVia: 'accessibility', canControlPeer: true },
  audioRouting: {
    canExportMediaAudio: true,
    canPresentVirtualDevice: false, // priv-app only
    canSplitDuplexLoop: false,
  },
  callHandoff: { method: 'os-bluetooth-hfp', canActAsHfpUnit: false },
};

/** Capability profile for a Windows PC client with the signed audio driver. */
export const WINDOWS_CAPS: DeviceCapabilities = {
  platform: 'windows',
  remoteView: { canBeViewed: true, canView: true, unattended: true },
  remoteControl: { controllableVia: 'sendinput', canControlPeer: true },
  audioRouting: {
    canExportMediaAudio: true,
    canPresentVirtualDevice: true, // licensed signed driver installed
    canSplitDuplexLoop: false,
  },
  callHandoff: { method: 'os-bluetooth-hfp', canActAsHfpUnit: true },
};

/**
 * Reference profile for a hypothetical iOS client, kept to document exactly
 * what iOS forecloses (SPEC §1). Not shipped in the MVP.
 */
export const IOS_CAPS: DeviceCapabilities = {
  platform: 'ios',
  remoteView: { canBeViewed: true, canView: true, unattended: false },
  remoteControl: { controllableVia: 'none', canControlPeer: true },
  audioRouting: {
    canExportMediaAudio: false,
    canPresentVirtualDevice: false,
    canSplitDuplexLoop: false,
  },
  callHandoff: { method: 'own-voip', canActAsHfpUnit: false },
};
