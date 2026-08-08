# Tether — reference client CLI

The client side of the protocol, implemented in Node/TypeScript. It is the
executable specification for what the Android (Kotlin) and Windows (C++) clients
must do: **register → Noise_IK handshake over the broker relay → verify the
peer's key fingerprints to the scanned device id → encrypted transport** (SPEC §4).

`src/link.ts` (`SecureLink`) is the reusable piece; port its state machine
faithfully to the native clients.

## Self-contained demo (no setup)

Starts an in-process broker, pairs a simulated phone + PC over it, and exchanges
encrypted messages both ways:

```bash
npm run demo -w apps/reference-cli
```

Expected tail: `✅ DEMO PASSED`.

## Two-process pairing (against a running broker)

```bash
# terminal 1
npm run dev -w apps/server

# terminal 2 — responder ("PC"): prints a QR blob, then waits
node apps/reference-cli/src/pair.ts responder

# terminal 3 — initiator ("phone"): paste the responder's QR blob
node apps/reference-cli/src/pair.ts initiator <qr-blob> "hello from the phone"
```

The QR blob is `base64(JSON{ id, key })` — the same `{device id, public key}` a
real QR carries. Set `SERVER_URL` to point at a non-default broker.

## What this proves

- The broker only ever relays opaque base64 blobs (zero-trust).
- Mutual authentication: pairing aborts if the peer's authenticated static key
  does not fingerprint to the expected device id (MITM/spoof rejection).
- Forward-secret transport via the Noise split ciphers.

## What it is NOT

No media (screen/audio) — that is the WebRTC layer on the native clients. This
CLI validates the control-plane: discovery, pairing, identity, and the encrypted
message channel that session setup rides on.
