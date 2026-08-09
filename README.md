# Tether

> **Codename — placeholder.** A cross-device continuity platform: phone ↔ PC pairing over a direct link, with remote view/control, session-scoped I/O routing, and live handoff of active sessions.

This monorepo implements the architecture in [`docs/SPEC.md`](docs/SPEC.md). Read the spec first — it is the source of truth for *what is buildable and why*. Every non-obvious constraint in the code (attended-only screen capture, no split-mic/speaker calls, OS-owned Bluetooth HFP for call handoff) traces back to a verdict there.

## MVP target

**Android (phone) ↔ Windows (PC).** iOS is deferred: it forecloses PC→phone control and cellular call handoff at the platform level (SPEC §1).

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
│   ├── android/           Phone client (Kotlin / Gradle) — scaffold
│   └── windows/           PC client (C++ core + libwebrtc) — scaffold
└── package.json           npm workspace root
```

## What runs today

The **protocol package** and the **signaling server** are implemented and runnable on Node 24+ (this machine's only installed toolchain). The Android and Windows clients are **structural scaffolds** — module layout, manifests declaring the exact OS capabilities the spec requires, and build files — because their toolchains (JDK/Gradle, MSVC/CMake) are not installed in this environment. Each client README lists the build prerequisites and the first implementation milestone.

```bash
# from repo root
npm install          # installs workspace dev deps (server has zero runtime deps)
npm run dev -w apps/server   # start the signaling broker on :8080
npm test -w apps/server      # 31 tests: broker, identity, Noise handshake, negotiation
npm run demo -w apps/reference-cli   # self-contained end-to-end pairing demo
```

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
