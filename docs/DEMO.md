# Recording the demo GIF

The GIF at the top of the README is what converts on a cold read, because most people never clone the repo. Aim for **20–30 seconds** that show the whole story: pairing is real cryptography, and the payoff is a live screen.

## The click sequence (shows the most in the least time)

1. Start on `http://localhost:8080` — the start screen, so the viewer sees what Tether is in one line.
2. Click **Try the demo**.
3. Let the handshake timeline run: the five steps flip to green in order (register → watch → msg1 → msg2 → verified). This is the part worth lingering on for a beat — it is the selling point.
4. The Live screen appears: the synthetic desktop is already streaming (moving windows, a live clock, a scrolling terminal).
5. Pan down to the **Encryption** panel so the cipher suite (`Noise_IK_25519_ChaChaPoly_BLAKE2s`) and the session fingerprint are visible, and the **Connection quality** panel showing the `host` ICE path.

Do it once end-to-end without hesitation. The demo pairs in under a second, so the timeline is quick — that is a feature; don't slow it down artificially.

## Capturing and compressing

On Windows, **ScreenToGif** (free) is the simplest: record the browser region, trim to the sequence above, export as GIF. Keep the capture region tight to the app.

To compress a screen recording to a small, sharp GIF with ffmpeg:

```bash
# from a .webm/.mp4 screen recording → a palette-optimized GIF under ~3 MB
ffmpeg -i recording.webm -vf "fps=12,scale=960:-1:flags=lanczos,palettegen" palette.png
ffmpeg -i recording.webm -i palette.png -vf "fps=12,scale=960:-1:flags=lanczos,paletteuse" docs/demo.gif
```

12 fps and 960px wide is the sweet spot: legible text, small file. Drop to `fps=10` or `scale=800` if GitHub balks at the size.

### The reproducible way (what produced the committed GIF)

A `record` Playwright project captures the demo headlessly with video on:

```bash
npm run record -w apps/web        # writes a .webm under apps/web/test-results/
```

Then convert it to `docs/demo.gif`. If you have no system ffmpeg, pull a static one just for this:

```bash
npx ffmpeg-static-bin --version   # or: npm i -D ffmpeg-static and use its binary path
ffmpeg -ss 2 -i <video.webm> -vf "fps=12,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" palette.png
ffmpeg -ss 2 -i <video.webm> -i palette.png -lavfi "fps=12,scale=900:-1:flags=lanczos,paletteuse=dither=bayer:bayer_scale=3" docs/demo.gif
```

The `-ss 2` trims the blank page-load and the connecting frames so the GIF opens on the live, streaming view. `docs/demo.gif` then appears at the top of the README.

## Putting the demo on a public URL

Demo mode is a good fit for a public link because it needs no second device: the page, the virtual device, and their loopback WebRTC connection all live in one browser tab, and the only server is the broker.

- **Deploy the broker with the built web client** to any host that serves Node and terminates TLS — Fly.io (`deploy/fly.toml`), Render, or a small VM behind Caddy (`docker compose up -d`). Build the client first (`npm run build:web`) so the broker serves `apps/web/dist`.
- **Set `TETHER_DEMO=1`** so the page auto-starts the demo, and serve over **HTTPS** (WebRTC and secure-context APIs require it). The demo's loopback connection uses host candidates, so it works without TURN.
- **Real cross-network pairing is the part that needs TURN.** Two people on different networks will not connect on STUN alone behind CGNAT or symmetric NAT. Configure `TURN_URIS` + `TURN_SECRET` (see [`DEPLOY.md`](DEPLOY.md)) for that; the demo link does not need it.

So: a public demo URL is practical and worth doing. A public *two-device* deployment is also practical but additionally needs a TURN server.
