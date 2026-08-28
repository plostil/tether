# @tether/web — browser client

The full Tether protocol from a plain web page: X25519 identity (persisted in
localStorage), Noise_IK over the broker's opaque relay, and a WebRTC
remote-view session. One bundle, two roles decided by the URL:

- **PC (responder)** — open `http://localhost:8080`. Registers, renders a QR
  whose URL carries this device's id + public key, waits for the phone, then
  shares its screen via `getDisplayMedia` (localhost = secure context).
- **Phone (initiator)** — scan the QR with the native camera app. Safari opens
  `http://<lan-ip>:8080/#pair=<blob>`; the page registers, watches the PC,
  handshakes, verifies the fingerprint, and renders the PC's screen track.
  View-only works on a plain-http page; that is why in-page QR *scanning*
  (getUserMedia, secure-context-only) is avoided by design.

## Why @noble instead of WebCrypto

WebCrypto has neither BLAKE2s nor ChaCha20-Poly1305, so the Noise primitives
come from `@noble/hashes` / `@noble/ciphers` / `@noble/curves` (bundled, pinned).
The handshake logic itself is shared with Node — `packages/protocol` exposes it
as `@tether/protocol/browser` (noise-core + pure types, no `node:crypto`).
`test/noise-noble-vectors.test.ts` locks this backend to
`docs/noise-test-vectors.json`; `test/interop.test.ts` handshakes it live
against the `node:crypto` backend.

## Build / test

```bash
npm run build -w apps/web    # esbuild -> dist/ (served by apps/server)
npm run watch -w apps/web    # rebuild on change
npm test -w apps/web         # vector conformance + node<->noble interop
```

`--platform=browser` is the enforcement that no `node:` import ever enters the
bundle — esbuild hard-errors instead of shimming.
