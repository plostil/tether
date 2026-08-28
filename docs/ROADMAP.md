# Roadmap

Derived from SPEC §3. The cut line: Phase 1 ships what stock, Play-distributable,
no-OEM-deal APIs allow, minus any research-grade DSP bet.

## Phase 0 — Foundation (in progress)

- [x] Architecture & feasibility spec (`docs/SPEC.md`)
- [x] Monorepo + shared protocol (`packages/protocol`)
- [x] Rendezvous/signaling broker, zero-trust, runnable + tested (`apps/server`)
- [x] Android & Windows client scaffolds (manifests, services, build files)
- [x] Noise_IK session library shared contract + cross-language test vectors — TS, Kotlin, and C++ all **compiled and run** against the shared vectors (byte-identical: same handshake bytes, handshake hash, and transport ciphertext; each cross-decrypts the others' output)
- [x] Deployable broker + coturn (docker compose, TLS via Caddy; Fly path for the broker)
- [x] `/ice` gating behind a session token (Bearer token issued at registration, per-device TURN creds)
- [x] Web client (`apps/web`) — full protocol in the browser: Noise core refactored to pluggable primitives (@noble backend, locked to the shared vectors), QR/URL pairing, PC→phone screen view over WebRTC, encrypted text channel. De-risks Phase 2's "iOS companion (view-only)" early: an iPhone can pair and view today via Safari, no native app.
- [x] Media/session layer design + negotiation logic ([docs/MEDIA.md](MEDIA.md); codec/direction rules tested). WebRTC media path is client-side (needs devices).

## Phase 1 — Attended continuity (MVP)

Green path first, in this order (both clients mirror the same milestone):

1. **Pairing + relay round-trip** — X25519 identity, QR fingerprint exchange,
   Noise_IK handshake over relayed blobs, encrypted hello.
2. **Phone → PC screen view** — MediaProjection → HEVC/H.264 → WebRTC → PC render.
3. **PC → phone control** — AccessibilityService gesture replay (view-only fallback).
4. **PC → phone view** — Windows.Graphics.Capture → WebRTC → phone render.
5. **Media/output audio routing** — AudioPlaybackCapture / WASAPI loopback, Opus.
6. **Whole-loop audio handoff** — move the entire audio session to one device.
7. **Cellular call handoff via OS Bluetooth HFP** — signaling/UI only (Phase 1.5 ok).
8. **Persistent presence** — Companion Device Manager + `connectedDevice` FGS.

Explicitly **excluded** from Phase 1 (with reasons): split mic/speaker calls,
cellular call-audio interception, unattended mirroring, iOS, Phone-Link-grade app
streaming / virtual mic. See SPEC §3.

## Phase 2+ — Gated on external decisions (see OPEN-QUESTIONS.md)

- OEM preload partnership → `COMPANION_DEVICE_APP_STREAMING` tier (virtual mic, app streaming).
- Distributed-AEC bet — only if split-device calling is a confirmed must-have.
- iOS companion (view-only + own-VoIP).
- EU DMA interoperability request (EU-only, 6–18 months, speculative).
