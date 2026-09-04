# Architecture

How a pairing request becomes an encrypted session, and how a session becomes a live video stream. This documents what the code in `packages/protocol`, `apps/server`, and `apps/web` actually does.

## Two planes

| Plane | Carries | Transport | Security |
|---|---|---|---|
| **Control** | pairing, capability hello, session offer/answer, ICE, input setup | broker relay (pairing) then the **Noise-encrypted channel** | Noise_IK (SPEC §4) |
| **Media** | screen video (and, on native clients, audio + an input DataChannel) | **WebRTC** peer connection, P2P | DTLS-SRTP |

The broker only ever sees opaque relay blobs. Session control (SDP/ICE) rides inside the Noise channel, so the media plane's identity is bound to the paired device — a man-in-the-middle cannot substitute its own SDP.

## Pairing → session → stream

```mermaid
sequenceDiagram
    autonumber
    participant A as Initiator (viewer)
    participant S as Broker (zero-trust)
    participant B as Responder (host / screen)

    Note over A,B: 1 — Identity. deviceId = base32(SHA-256(X25519 public key)).

    A->>S: register {deviceId, publicKey}
    S-->>A: registered {sessionToken}
    B->>S: register {deviceId, publicKey}
    S-->>B: registered {sessionToken}
    Note over S: verifies each publicKey fingerprints to its deviceId

    A->>S: watch B
    S-->>A: peer-status {B, online}

    Note over A,B: 2 — Noise_IK handshake, end-to-end inside opaque relay blobs.
    A->>S: relay(B, msg1 = e, es, s, ss)
    S->>B: deliver(from A, msg1)
    B->>S: relay(A, msg2 = e, ee, se)
    S->>A: deliver(from B, msg2)
    Note over A,B: both split into send/recv ChaCha20-Poly1305 ciphers;<br/>each checks the peer key fingerprints to the expected id

    Note over A,B: 3 — Capabilities + intent (encrypted).
    A->>B: hello {name, capabilities}
    B->>A: hello {name, capabilities}
    A->>B: view-request {mode}

    Note over A,B: 4 — WebRTC negotiation (encrypted); negotiateSession() gates it.
    B->>A: session-offer {sdp}
    Note over A: negotiateSession(remote-view, caps) → ok
    A->>B: session-answer {sdp}
    A-->>B: ice-candidate * (trickle)
    B-->>A: ice-candidate * (trickle)

    Note over A,B: 5 — Media flows P2P over DTLS-SRTP (host-to-host on a LAN).
    B-->>A: screen video
```

1. **Identity.** A device's long-term identity *is* its X25519 public key; the device id is the base32 SHA-256 fingerprint of that key (the Syncthing model). There is no registry to trust. `packages/protocol/src/identity.ts`, `apps/web/src/crypto-noble.ts`.
2. **Register.** Each device opens a WebSocket to `/signal` and registers. The broker verifies the presented key fingerprints to the claimed id, then issues a short-lived session token (which gates `GET /ice`). `apps/server/src/broker.ts`.
3. **Handshake.** The initiator scanned the responder's key (QR or join code), so it runs Noise_IK as the initiator: message 1 carries its ephemeral key and its static key encrypted to the responder's known key; message 2 comes back; three X25519 agreements feed a BLAKE2s KDF and both sides derive the same transport keys. Each side confirms the authenticated remote key fingerprints to the id it expected (anti-MITM). `packages/protocol/src/noise-core.ts`, `apps/web/src/secure-link.ts`.
4. **Capabilities + WebRTC.** Over the encrypted channel the peers exchange a `hello` with their capabilities, then the viewer sends `view-request`. The screen side builds a WebRTC offer; the viewer runs `negotiateSession` before answering (rejecting impossible sessions with a reason). SDP and ICE candidates all travel inside the Noise channel. `apps/web/src/rtc.ts`, `packages/protocol/src/session.ts`.
5. **Media.** The WebRTC connection establishes P2P and video flows over DTLS-SRTP. On a LAN this is host-to-host; STUN/TURN from `GET /ice` is the fallback. The viewer's UI reads `getStats()` for round-trip, bitrate, resolution, and the ICE candidate type.

## Reliability model (browser SecureLink)

The link is a live, user-facing connection, so `apps/web/src/broker-client.ts` + `secure-link.ts` add a state machine on top of the one-shot handshake:

- **BrokerClient** owns one WebSocket per identity: register, watch (re-armed on every re-register), relay, reconnect with backoff, and offline/online awareness. A displaced registration (another tab on the same origin) surfaces a clear fault instead of a silent hang.
- **SecureLink** runs the handshake over that client with: msg1 re-sent on the peer's offline→online edge; a 15s handshake deadline (retryable timeout); responder re-arm so a reconnected initiator re-pairs without the host reloading; a self-pair guard; and every delivered frame decoded inside `try/catch` → a typed fault mapped to the UI. On a reconnect it re-pairs transparently and tears down any stale media.

## Demo mode

`apps/web/src/demo/virtual-device.ts` is a second, independent device living in the same tab: its own identity (a different `localStorage` key → a different device id, so the broker does not treat it as a duplicate), its own WebSocket, and a real Noise responder. The page pairs with it over the real broker and real handshake; the virtual device shares a synthetic canvas desktop (`fake-desktop.ts`) over a real WebRTC connection. Swap the canvas for `getDisplayMedia` and it is the two-machine flow — nothing is mocked.

## iPhone control bridge

`apps/ios-bridge` is a local Node process that supervises `go-ios` (tunnel → mount developer image → forward ports → run WebDriverAgent) over USB, proxies the phone's MJPEG screen, and exposes a token-gated control API (tap/drag/keys/button) that maps normalized coordinates to the device's points. The web client's iPhone mode renders the stream and forwards input; it can also re-share the phone's screen to a paired device through the same WebRTC path. See [`IOS-CONTROL.md`](IOS-CONTROL.md).
