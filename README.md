# Tether

> **Codename — placeholder.** A cross-device continuity platform: phone ↔ PC pairing over a direct link, with remote view/control, session-scoped I/O routing, and live handoff of active sessions.

This monorepo implements the architecture in [`docs/SPEC.md`](docs/SPEC.md). Read the spec first — it is the source of truth for *what is buildable and why*. Every non-obvious constraint in the code (attended-only screen capture, no split-mic/speaker calls, OS-owned Bluetooth HFP for call handoff) traces back to a verdict there.

## MVP target

**Android (phone) ↔ Windows (PC).** iOS is deferred as a *native* client: it forecloses PC→phone control and cellular call handoff at the platform level (SPEC §1). A **web client** (`apps/web`) covers the iPhone-testable subset today — pairing, encrypted messaging, and viewing the PC's screen from Safari (see below).

## Repository layout

```
tether/
├── docs/                  Specification and design docs
│   └── SPEC.md            Architecture & feasibility spec (the contract)
├── packages/
│   └── protocol/          Shared wire protocol: device identity, signaling,
│                          session control, capability negotiation (TypeScript)
├── apps/
│   ├── server/            Rendezvous + signaling broker (Node/TypeScript) — RUNNABLE
│   ├── reference-cli/     Reference client: pairing + Noise session over the broker — RUNNABLE
│   ├── web/               Browser client: PC shares its screen, phone (iPhone
│   │                      Safari included) pairs and views it — RUNNABLE
│   ├── android/           Phone client (Kotlin / Gradle) — scaffold
│   └── windows/           PC client (C++ core + libwebrtc) — scaffold
└── package.json           npm workspace root
```

## What runs today

The **protocol package** and the **signaling server** are implemented and runnable on Node 24+ (this machine's only installed toolchain). The Android and Windows clients are **structural scaffolds** — module layout, manifests declaring the exact OS capabilities the spec requires, and build files — because their toolchains (JDK/Gradle, MSVC/CMake) are not installed in this environment. Each client README lists the build prerequisites and the first implementation milestone.

```bash
# from repo root
npm install          # installs workspace dev deps (server has zero runtime deps)
npm run build:web    # bundle the browser client into apps/web/dist
npm run dev -w apps/server   # broker on :8080, also serves the web client
npm test             # broker, identity, Noise (node + noble backends), negotiation, static
npm run demo -w apps/reference-cli   # self-contained end-to-end pairing demo
```

## Test with an iPhone (or any phone) on your Wi-Fi

The web client runs the real protocol — X25519 identity, Noise_IK over the
broker relay, WebRTC media — from a plain browser page, so an iPhone can pair
and view the PC screen with no native app:

1. Once, in an **admin** PowerShell: `powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1`
   (opens inbound TCP 8080 on private networks and prints this PC's LAN address).
2. `npm run build:web` then `npm run dev -w apps/server`.
3. On the PC, open **http://localhost:8080** — it registers and shows a QR.
4. On the phone (same Wi-Fi), scan the QR with the native camera. Safari opens
   the pairing URL; the page registers, handshakes end-to-end, and both sides
   show the same verified fingerprint.
5. Click **Share screen** on the PC — the desktop appears in the phone's page.
   The text box under it is an encrypted message channel, both directions.

Notes: the QR carries the PC's *public* key in the URL fragment (never sent to
the server). The PC page must be opened via **localhost** (secure context for
`getDisplayMedia`); the phone side is view-only and works over plain http. If
the phone can't connect, check that your router does not isolate Wi-Fi clients
(AP isolation).

## Design invariants (do not violate without revisiting the spec)

1. **The server is zero-trust.** It brokers discovery and relays opaque handshake/signaling blobs. It never sees session media and never holds a key that can decrypt a session. End-to-end security is the devices' Noise session (SPEC §4).
2. **Screen capture and control are attended-only.** No always-on/unattended mirroring path exists on stock Android (MediaProjection dies on lock). Don't design flows that assume it.
3. **Never intercept cellular call audio.** Call handoff rides the OS Bluetooth HFP stack; the app does signaling/UI only (SPEC §2.3).
4. **Audio routes by whole-device ownership, not per-transducer.** Split mic/speaker full-duplex calling is unsupported in v1 (distributed AEC, SPEC §2.2).

## Deploy the backend

The broker + TURN are containerized. On a VM with a public IP and a domain:

```bash
cp deploy/.env.example .env   # set domains, public IP, TURN_SECRET
docker compose up -d          # broker (behind Caddy/TLS) + coturn
```

Clients then use `wss://$BROKER_DOMAIN/signal` and fetch STUN/TURN from `/ice`.
Full instructions, firewall ports, and the Fly.io path: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## Status

Pre-alpha scaffold. See [`docs/ROADMAP.md`](docs/ROADMAP.md) for phase breakdown and [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) for decisions that gate later phases.

## License

Placeholder — see [`LICENSE`](LICENSE). Note the HEVC patent-pool exposure flagged in SPEC §4 before shipping a codec default.
