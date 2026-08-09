# Tether — Android client

Phone side of the Android ↔ Windows MVP. Implements screen export (MediaProjection),
PC→phone control (AccessibilityService), media-audio export (AudioPlaybackCapture),
the persistent link (Companion Device Manager), and pairing (QR + X25519 + Noise).

> **Not buildable in the scaffold environment** — this repo was scaffolded on a
> machine without a JDK/Android SDK. This module is structurally complete
> (manifest, service declarations, Gradle, key sources) but needs the toolchain
> below to compile.

## Prerequisites

- JDK 17
- Android SDK Platform **API 37** (Android 17) + build-tools; a device/emulator on API 29+
- Android Gradle Plugin 8.6+, Kotlin 2.0+
- The running signaling server (`npm run dev -w apps/server`) reachable from the device

## Build

```bash
cd apps/android
./gradlew :app:assembleDebug
./gradlew :app:installDebug     # to a connected device
```

(There is no Gradle wrapper checked in yet — run `gradle wrapper --gradle-version 8.10`
once with a local Gradle, or generate it from Android Studio on first open.)

## Module map (all under `app.tether`)

| Area | File | Spec verdict it implements |
|---|---|---|
| Identity | `pairing/DeviceIdentity.kt` | §4 — device ID = base32(SHA-256(X25519 pubkey)); must match `packages/protocol` |
| Noise session | `pairing/Noise.kt` | §4 — Noise_IK port; byte-compatible with `packages/protocol/src/noise.ts` |
| Secure link | `net/SecureLink.kt` | §4 — register → handshake → verify → encrypted transport (port of reference-cli `link.ts`) |
| Signaling | `net/SignalingClient.kt` | §4 — zero-trust broker; opaque relay only |
| Screen export | `capture/ScreenCaptureService.kt` | §2.1 — attended-only, dies on lock |
| PC→phone control | `control/RemoteControlService.kt` | §2.1 — AccessibilityService; degrade to view-only |
| Media audio | `audio/MediaAudioCapture.kt` | §2.2 — media/game only; VoIP excluded |
| Persistent link | `presence/LinkService.kt` | §2.8 — `connectedDevice` FGS |
| Presence wake | `presence/CompanionPresenceService.kt` | §2.8 — CDM presence |

## Verifying the Noise port (no device needed)

The Noise_IK handshake is ported in `pairing/Noise.kt` and cross-checked against
the TypeScript reference via shared vectors:

```bash
./gradlew :app:testDebugUnitTest   # runs NoiseVectorsTest on the JVM
```

`NoiseVectorsTest` embeds the same bytes as `docs/noise-test-vectors.json` and
`apps/server/test/noise-vectors.test.ts`. If both the Kotlin and TS tests pass,
the handshakes are wire-compatible. Requires JDK 11+ (for ChaCha20-Poly1305).

## First implementation milestone

**Pair + relay round-trip, no media yet:**

1. Generate/persist the X25519 identity (`DeviceIdentity`, Keystore-backed).
2. Show a QR of `{deviceId, publicKey}`; scan the PC's QR (or vice-versa).
3. Connect `SignalingClient` to the server; confirm `registered`.
4. Perform a Noise_IK handshake with the PC over relayed blobs; confirm both
   sides derive the same session keys and the peer's key fingerprints to the
   scanned device ID.
5. Send an encrypted "hello" application message end-to-end.

Only after that green path works, layer on: MediaProjection screen export →
WebRTC video → AccessibilityService control → media audio → call handoff.

## Do not

- Assume unattended capture (there is no stock API; MediaProjection dies on lock).
- Try to capture cellular or VoIP call audio (blocked — SPEC §2.2/§2.3).
- Ship the AccessibilityService without the Play policy declaration + prominent
  disclosure, or it will be rejected/suspended.
