# Manual testing — screen share & remote control

Automated coverage lives in `apps/server/test` (`input.test.ts`, `inject.test.ts`,
`wda-client.test.ts`, `ios-control.test.ts`, plus the existing session/media
suites). This file covers the end-to-end paths that need real devices.

## Prerequisites

```bash
npm install
npm run build:web
WEB_ROOT=apps/web/dist PORT=8080 node apps/server/src/index.ts   # broker on :8080, serves the web client
```

Run `scripts/allow-firewall.ps1` once (as admin) so the phone can reach the PC on
the LAN. Open **http://localhost:8080** on the PC in Chrome (localhost is a secure
context, required for `getDisplayMedia`).

## 1. Phone controls the PC (headline path)

1. PC: click **Show pairing QR**. The **Remote control** panel shows
   *"Let the paired device control this PC"* — this confirms the localhost
   `/inject` channel connected (the debug log prints "input injection available
   on this PC").
2. PC: click **Share my screen** and pick a screen/window.
3. Phone: scan the QR (Safari or Android Chrome), which opens the client and pairs.
   The phone auto-requests the view and the PC screen appears.
4. PC: tick **Let the paired device control this PC**.
5. Phone: touch the video — the PC cursor follows; tap = click; drag = move with
   the button down; two fingers dragged vertically = scroll. Tap **Keyboard** and
   type — text lands on the PC.
6. Untick the box: input goes inert immediately (verify the cursor stops
   responding). This is the kill switch.

Injection is Windows-only, primary-monitor-only in v1, and cannot reach the
secure desktop (UAC / lock screen).

## 2. iPhone shares its camera to the PC

1. Pair as above (PC hosts, iPhone scans QR).
2. iPhone: click **Share my camera**, accept the camera prompt. The PC renders
   the camera stream. (iPhone Safari has no screen-capture API, so the camera is
   the phone→PC path; Android Chrome can instead use **Share my screen**.)
   Note: on iOS the camera prompt needs a secure context — if the phone loaded the
   page over the LAN IP on plain http, serve the client over HTTPS (see the Caddy
   deploy) for camera support.

## 3. PC controls an Android phone (Phase E — build in Android Studio)

Requires the native Android app (`apps/android`) built with the pinned
`io.github.webrtc-sdk` dependency, MediaProjection capture wired to a WebRTC
track, and the DataChannel observer forwarding frames to
`control/InputReceiver.onEvent`. The user must enable Tether's
`RemoteControlService` in Android accessibility settings. (iOS is not
controllable peer-to-peer; the host-tethered WDA path is section 4.)

## 4. PC controls an iPhone via WebDriverAgent (W2)

The iPhone is not a tether peer here — it runs Apple's WebDriverAgent (WDA),
and the PC drives it over the LAN. Full setup (including getting WDA onto the
phone without a Mac) is in `docs/IOS-CONTROL.md`. Quick E2E once WDA is running:

1. Confirm `http://<iphone-ip>:8100/status` responds from the PC.
2. Start the server (`WEB_ROOT=apps/web/dist PORT=8080 node apps/server/src/index.ts`),
   optionally with `WDA_URL=http://<iphone-ip>:8100` to prefill the target.
3. PC Chrome at **http://localhost:8080** shows an **iOS control** panel (it
   appears only when the localhost `/ios-control` channel connects). Enter the
   WDA URL, click **Connect** — the iPhone screenshot stream appears.
4. Tick **Allow control of the paired iPhone**. Click/drag on the screenshot →
   taps and swipes land on the phone; the hidden keyboard field types text.
5. Untick the box → control goes inert immediately (the kill switch); the
   screenshot view keeps updating.
6. Kill WDA on the phone → status shows *iPhone unreachable* and reconnects when
   WDA returns.

The screenshot view is low-fps (WDA `/screenshot` polling), enough for
click-targeting; smooth mirroring would need the deferred ReplayKit→WebRTC path.

## 5. PC controls an iPhone with NO app installed (pymobiledevice3, iOS 17+)

The default backend. Nothing is installed on the iPhone — only one-time popups.
Full setup is in `docs/IOS-CONTROL.md`; quick E2E:

1. iPhone: tap **Trust This Computer** (first USB connect) and enable
   **Settings → Privacy & Security → Developer Mode** (reboot + confirm).
2. PC: `pip install -U pymobiledevice3`, then run `scripts/ios-tunnel.ps1` as
   admin (mounts the Developer Disk Image + starts the tunnel daemon; leave it
   open). Sanity check:
   `pymobiledevice3 developer core-device get-display-info --tunnel ''`.
3. Start the server (`IOS_BACKEND=hid` is the default):
   `WEB_ROOT=apps/web/dist PORT=8080 node apps/server/src/index.ts`.
4. PC Chrome at **http://localhost:8080** → **iOS control** panel (no WDA-URL
   field for this backend) → **Connect** → screenshot stream appears →
   **Allow control** → click/drag drives real taps/swipes.
5. Untick → inert. Unplug USB with a network tunnel (iOS 17.4+) → still works
   wirelessly. Text entry isn't supported on this backend (use `IOS_BACKEND=wda`).
