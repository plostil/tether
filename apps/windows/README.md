# Tether — Windows client

PC side of the Android ↔ Windows MVP. It is the unconstrained end of the pair
(SPEC §1): screen capture, input injection, and audio capture are all documented
APIs. The only friction is presenting a *virtual* audio device, which needs a
signed driver (below).

> **Not buildable in the scaffold environment** — scaffolded on a machine with
> no MSVC/CMake. Headers describe the interfaces and the architecture decisions;
> `.cpp` implementations are the first build task.

## Architecture decisions (from SPEC §2.1, §2.2, §4)

| Concern | Decision | Why (rejected alt) |
|---|---|---|
| Screen capture | **Windows.Graphics.Capture** (WinRT), MSIX-packaged for borderless via `graphicsCaptureWithoutBorder` | DXGI Desktop Duplication: no per-window, breaks on hybrid GPU |
| Input injection | **SendInput** from a signed, `%ProgramFiles%`-installed, `uiAccess=true` helper | InputInjector needs a packaged restricted cap; kernel filter driver is WHCP+liability |
| Secure desktop (UAC/lock) | **SYSTEM service** that detects the input-desktop switch and re-attaches a helper into `Winsta0\Winlogon` | No API injects into the secure desktop directly |
| Audio capture | **WASAPI loopback** + per-process loopback (`ActivateAudioInterfaceAsync` + `PROCESS_LOOPBACK`, build 20348+) | — |
| Virtual mic/speaker | **License a signed driver** (Thesycon TVirtAudio, or open-source Virtual-Audio-Driver); ship in the installer | Building/WHCP-certifying our own ACX driver is post-April-2026 EV+Partner-Center cost |
| Call handoff | PC pairs as a normal **OS Bluetooth HFP** hands-free unit; we never touch PCM | `PhoneLineTransportDevice.RegisterApp()` broken for 3rd parties since Win11 22H2 |
| Media/RTC | **libwebrtc** + external HW video encoder factory (NVENC/AMF/QSV) | Pion has no client media/HW codec layer |

## Prerequisites

- Visual Studio 2022 (v143) with C++ Desktop workload, Windows 11 SDK (build 22621+)
- CMake 3.28+
- A libwebrtc build (or a maintained prebuilt) for `x64-windows`
- For control across the secure desktop: an Authenticode/EV signing cert (the
  `uiAccess=true` helper must be signed and installed under `%ProgramFiles%`)

## Build (once implementations land)

```powershell
cmake --preset x64-release
cmake --build --preset x64-release
```

## Target map (see CMakeLists.txt)

- `tether_core`   — signaling client, Noise session, WebRTC transport, session coordinator
- `tether_capture`— Windows.Graphics.Capture → encoder
- `tether_input`  — SendInput helper (built with the `uiAccess` manifest)
- `tether_audio`  — WASAPI loopback + virtual-device control
- `tether_service`— SYSTEM service for secure-desktop input relay
- `tether_app`    — tray app / UI shell

## First implementation milestone

Mirror the Android milestone: connect `SignalingClient` to `apps/server`,
complete a Noise_IK handshake with the phone over relayed blobs, verify the
peer's key fingerprints to the scanned device ID, exchange an encrypted hello.
Only then add WGC capture → WebRTC, then SendInput, then audio.
