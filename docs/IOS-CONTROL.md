# PC → iPhone control

Tether can drive an iPhone from the PC. Unlike every other tether path, **the
iPhone is not a tether peer here** — the PC owner drives **their own** device
over a host-tethered, owner-operated channel; there is no remote peer and no
covert path. Neither backend touches the broker / Noise / `negotiateSession`.

Two backends implement it, selected by `IOS_BACKEND`:

- **`hid` (default) — no app installed on the iPhone.** Uses
  [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3)'s
  `universal-hid-service` over Apple's iOS 17+ developer tunnel to inject real
  taps/drags, with `dvt screenshot` for the view. The only iPhone-side steps are
  one-time popups/toggles — **no download.** This is the recommended path; jump
  to *No-install backend* below.
- **`wda` — WebDriverAgent over the LAN.** Needs WDA installed and signed on the
  iPhone; adds real text entry and works on iOS < 17. Covered in the second half.

---

## No-install backend (`IOS_BACKEND=hid`, iOS 17+)

`pymobiledevice3`'s `developer core-device universal-hid-service` is a
system-level developer service — **not an app you sideload.** Tether spawns it
as a persistent child and streams gesture lines on stdin (`tap X Y`,
`drag X1 Y1 X2 Y2`), exactly as the `/inject` subsystem streams to a PowerShell
host. Coordinates are the HID absolute **0..65535** space (center = 32768), so
tether's normalized `InputEvent` maps by `×65535`. The screen view polls
`developer dvt screenshot`.

Code: `apps/server/src/ios-control/hid-tunnel-controller.ts` (behind the same
`backend.ts` interface, `/ios-control` channel, screenshot pump, and web panel
as the WDA backend).

### iPhone side — no download, just popups/toggles

1. Plug in USB once and tap **Trust This Computer**.
2. Enable **Settings → Privacy & Security → Developer Mode** (toggle → reboot →
   confirm popup). That's it — nothing is installed.

### PC side — one-time tooling + a tunnel

1. Install pymobiledevice3 (PC only): `pip install -U pymobiledevice3`.
2. Bring up the tunnel as **admin** (it creates a TUN interface):
   `powershell -ExecutionPolicy Bypass -File scripts\ios-tunnel.ps1` — this mounts
   the Apple-signed Developer Disk Image (`mounter auto-mount`) and starts the
   tunnel daemon (`remote tunneld`). Leave that window open. Re-run after a phone
   reboot (the disk image unmounts).
3. Sanity check: `pymobiledevice3 developer core-device get-display-info --tunnel ''`
   returns the screen size. Tether's backend auto-discovers the device the same
   way (`--tunnel ''`).

### Running it

```bash
npm run build:web
IOS_BACKEND=hid node apps/server/src/index.ts     # PowerShell: $env:IOS_BACKEND="hid"
```

Open **http://localhost:8080** on the PC → the **iOS control** panel appears
(localhost-gated) → **Connect** → the iPhone screenshot stream shows → tick
**Allow control** → click/drag on it drives real taps/swipes.

**Wired vs wireless:** USB is the reliable transport. iOS 17.4+ also supports a
network (wireless) tunnel. On Windows, iOS 17.0–17.3.1 needs extra tunnel drivers;
17.4+ is clean.

**Limitations (v1):** no app-free text entry over `universal-hid-service` — use
the `wda` backend when you need to type; the screenshot view is low-fps (a live
CoreMediaIO stream is the future upgrade); multi-touch/pinch isn't synthesized.

---

## WebDriverAgent backend (`IOS_BACKEND=wda`)

It runs Apple's [WebDriverAgent](https://github.com/appium/WebDriverAgent) (WDA),
which exposes an HTTP server on the LAN (default `:8100`). The co-located tether
server dials it and replays taps/swipes/text — structurally identical to how the
`/inject` subsystem drives a local PowerShell host for PC input. Use this for
text entry or iOS < 17.

Because this never involves a tether peer, it does **not** touch the broker,
the Noise transport, or `negotiateSession`. `IOS_CAPS.remoteControl.controllableVia`
stays `'none'` — that models *peer* controllability (no on-device iOS injection
API exists, SPEC §1 appendix), which remains true. This is a separate,
owner-operated, host-tethered subsystem.

## What you get (and what you don't)

- **Control:** real taps, swipes, long-press, scroll, and text entry, via WDA's
  W3C Actions API and `wda/*` helpers. The normalized `InputEvent` schema
  (`packages/protocol/src/input.ts`) is reused verbatim; `IosController`
  synthesizes gestures from the `pdown→pup` stream exactly like the Android
  `InputReceiver`.
- **View:** a low-fps screenshot stream (WDA `GET /screenshot`, polled a few
  times a second). Enough to see what you're targeting; **not** smooth
  mirroring. Real-time video would need a ReplayKit → WebRTC broadcast app,
  which requires a signed iOS app / a Mac and is deliberately out of v1 scope.
- **Not supported:** multi-touch/pinch (v1 synthesizes single-finger gestures),
  hardware-key events (typing rides `text`), and back/recents (iOS has only
  Home).

## Architecture

```
PC browser UI  --ws://127.0.0.1:<port>/ios-control-->  tether server  --HTTP :8100 over LAN-->  iPhone WDA
  paints screenshot frames  <---- {t:'ios-frame',png} -- screenshot pump <-- GET /screenshot
  captures pointer/touch    ---- InputEvent JSON ---->  IosController   --> POST .../actions | wda/*
```

Code: `apps/server/src/ios-control/` (`wda-client.ts`, `controller.ts`,
`screenshot-pump.ts`, `channel.ts`) and `apps/web/src/ios-control-link.ts`.

The `/ios-control` WebSocket is gated the same three independent ways as
`/inject`:

1. **Localhost only** — the socket must come from loopback; a phone (which loads
   the page over the PC's LAN IP) can't reach it, so the panel stays hidden.
2. **Auth** — the first frame must carry a valid session token
   (`broker.validateSession`, same check as `/ice`).
3. **Runtime opt-in** — control is inert until you tick **Allow control of the
   paired iPhone**. The screenshot *view* starts on connect; only *control* is
   gated by the toggle.

## Getting WDA onto the iPhone (no Mac required)

WDA is normally built with Xcode, but you can run a prebuilt copy without a Mac
using [`go-ios`](https://github.com/danielpaulus/go-ios) (a cross-platform
usbmuxd client that also runs on Windows):

1. Connect the iPhone by USB the first time; trust the computer.
2. Install a WebDriverAgent `.ipa`. You can sideload a prebuilt WDA with `go-ios`
   (`ios install --path=WebDriverAgent.ipa`) or a sideloading tool such as
   SideStore / AltStore. Signing options:
   - **Free Apple ID:** works, but the developer certificate **expires in ~7
     days** — you must re-sign/re-install roughly weekly.
   - **Paid Apple Developer account (~$99/yr):** the cert lasts ~1 year.
   - A cloud signing service can automate re-signing before expiry.
3. On the phone: **Settings → General → VPN & Device Management** → trust the
   developer certificate.
4. Start WDA and expose its server:
   `ios runwda --bundleid=<wda-bundle-id> --testrunnerbundleid=<...> --xctestconfig=WebDriverAgentRunner.xctest`
   then reach it over the LAN once Wi-Fi is up.
5. Verify from the PC: `curl http://<iphone-ip>:8100/status` returns JSON.

The iPhone and PC must be on the **same subnet with client isolation off** (see
the wireless build checklist §1) for the PC to reach `:8100`.

## Running it

```bash
npm run build:web
WEB_ROOT=apps/web/dist PORT=8080 WDA_URL=http://<iphone-ip>:8100 node apps/server/src/index.ts
```

`WDA_URL` is optional — the PC UI has a field to enter/override it. Then open
**http://localhost:8080** on the PC, enter the WDA URL, **Connect**, and tick the
control box. Manual E2E steps are in `docs/TESTING.md` §4.

Config flags (`apps/server/src/config.ts`): `IOS_CONTROL=false` disables the
channel entirely; `WDA_URL` sets the default target.

## Security

The channel from the PC browser to the server is localhost + token + opt-in
gated. The hop from the server to WDA is a plain LAN HTTP request, and **WDA's
`:8100` is unauthenticated** — anyone on the subnet can drive the phone while WDA
is running. Mitigations:

- Run this only on a **trusted network** (home Wi-Fi, not guest/office SSIDs).
- Tether only dials a pinned target URL and never exposes a WDA proxy of its own.
- Stop WDA (`ios runwda` process) when you're done.

WDA can't easily be put behind TLS, so treat "WDA is running" as "this phone is
controllable by the LAN" and scope the network accordingly.

## Failure handling

A dead session (WDA crashed, cert expired, phone locked/slept) makes the next
WDA call fail; `IosController` drops the cached session, surfaces
*iPhone unreachable* in the UI, and retries with backoff — the same
restart-with-backoff shape as `apps/server/src/inject/injector.ts`. When WDA
comes back, the session and screenshot stream resume without a page reload.
