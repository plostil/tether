# Controlling an iPhone from the PC

Tether can drive an iPhone from the PC — live screen plus real taps, drags, and typing — over a USB cable. This is the honest, working route, and it is not an App Store or web capability.

## Why it has to work this way

iOS exposes **no event-injection API** to any app, and no MDM remote-control command. TeamViewer and AnyDesk both ship view-only on iOS and say so. The only sanctioned way to synthesize touches on a real device is Apple's **XCTest** UI-automation framework, which is exactly what **WebDriverAgent** (WDA, from the Appium project) wraps in an HTTP server. WDA runs on the device as a developer-signed test runner; **go-ios** launches and talks to it from Windows/Linux without a Mac at runtime. So the design is: a dev-signed WDA on the phone, go-ios over USB, and Tether's `apps/ios-bridge` orchestrating both and exposing a small local API the web UI uses.

Constraints, up front:

- **USB only**, and **attended** — the phone must be unlocked and trusted.
- The screen stream is **MJPEG at roughly 10–15 fps**; taps are XCTest-synthesized, so latency is ~100 ms, not frame-perfect gaming input.
- A **free Apple ID** signs the runner for **7 days**; re-sign weekly. A paid Apple Developer account lasts a year.
- Tested against **iOS 26** with the go-ios userspace tunnel (the maintainer's supported path as of Aug 2026). iOS 17/18 also work.

## One-time setup

### 1. Get the WebDriverAgent runner (no Mac needed)

Building WDA needs Xcode, so build it in CI:

1. In this repo's **Actions** tab, run the **build-wda** workflow (or push a `wda-*` tag). It builds `WebDriverAgentRunner` for a real device on a macOS runner, strips the embedded XCTest frameworks (iOS 17+), and uploads `WebDriverAgentRunner.ipa`.
2. Download that artifact to the PC.

If you have a Mac with Xcode, you can build and sign it there instead and skip Sideloadly.

### 2. Sign and install it on Windows (free Apple ID)

1. Install **iTunes from apple.com** (not the Microsoft Store build) so the Apple Mobile Device USB driver and service are present. Sideloadly and go-ios both need them.
2. Install **[Sideloadly](https://sideloadly.io/)**.
3. Connect the iPhone over USB, unlock it, and tap **Trust This Computer**.
4. In Sideloadly, drag in `WebDriverAgentRunner.ipa`, enter your free Apple ID, and install. Sideloadly re-signs it; the bundle id ends in `.xctrunner` (e.g. `com.<you>.WebDriverAgentRunner.xctrunner`).
5. On the phone: **Settings → General → VPN & Device Management** → trust your developer certificate. Then **Settings → Privacy & Security → Developer Mode** → on (the phone reboots).

Re-run Sideloadly weekly to refresh the 7-day signature.

### 3. Install go-ios and wintun

```bash
npm i -g go-ios          # the `ios` CLI, MIT-licensed
```

On Windows, download `wintun.dll` from <https://git.zx2c4.com/wintun> and copy it into `C:\Windows\System32` (go-ios needs it for the iOS 17+ tunnel).

## Running it

1. Start the bridge on the PC:

   ```bash
   npm start -w apps/ios-bridge
   ```

   It prints a setup URL with a one-time token, e.g.
   `http://localhost:8080/#/iphone/setup?bridge=http://127.0.0.1:8090&token=…`.

2. Open that URL in the Tether web app (or choose **Control an iPhone** on the start screen and paste it). The **setup screen** shows a live checklist: go-ios present, wintun present, Apple driver running, iPhone connected + trusted, WDA installed. Each red item has a fix.

3. When the checklist is green, click **Start bridge**. The bridge runs, in order:

   ```
   ios tunnel start --userspace        # kept running (iOS 26 path)
   ios image auto                      # mount the developer disk image
   ios forward 8100 8100               # WDA control port
   ios forward 9100 9100               # WDA MJPEG stream port
   ios runwda --bundleid=<id>.xctrunner \
              --testrunnerbundleid=<id>.xctrunner \
              --xctestconfig=WebDriverAgentRunner.xctest
   ```

   The screen shows each process and its log tail. Once WDA answers `/status`, the bridge opens a session and reads the window size.

4. It jumps to the **live view**: the phone screen renders from the MJPEG stream, and pointer/keyboard input is forwarded. Tap to tap, drag to swipe, type to type, and use **Home**.

If your WDA bundle id differs, set `WDA_BUNDLE_ID` when starting the bridge:

```bash
WDA_BUNDLE_ID=com.you.WebDriverAgentRunner.xctrunner npm start -w apps/ios-bridge
```

## Sharing the iPhone to a paired device

The PC page can also re-share the iPhone screen to another Tether device: it draws the MJPEG frames onto a canvas and feeds them through the same WebRTC path used for screen sharing, and forwards control messages received over the Noise channel back to the bridge. So "view/control the iPhone from a second device, via the PC" works too.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Checklist: go-ios not found | `npm i -g go-ios`, then restart the bridge. |
| Checklist: wintun missing | Copy `wintun.dll` into `C:\Windows\System32`. |
| Checklist: Apple driver not running | Install iTunes from apple.com (not the Store); reconnect the phone. |
| Checklist: no device | Unlock the phone, tap Trust, enable Developer Mode. |
| Checklist: WDA not installed / expired | Re-sign and reinstall the `.ipa` with Sideloadly (7-day free-account limit). |
| `runwda` fails to reach testmanagerd on iOS 26 | Ensure the tunnel step uses `--userspace` and stays running (the bridge does this). |
| Live view blank | The MJPEG stream or the runner is not up yet; watch the process logs on the setup screen. |

## The bridge API (for reference)

The bridge serves a token-gated API on `127.0.0.1:8090`:

`GET /iphone/status`, `GET /iphone/events` (SSE), `POST /iphone/start`, `POST /iphone/stop`, `GET /iphone/stream` (MJPEG), `POST /iphone/tap|double-tap|long-press|drag|keys|button`. Coordinates are 0..1 fractions; the bridge scales them to device points via WDA's `/window/size`.
