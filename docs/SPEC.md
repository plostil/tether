# Cross-Device Continuity — Architecture & Feasibility Spec

**Status:** Pre-build feasibility. Spec-only.
**Verified:** August 2026 against current shipping platforms — iOS 26.x, Android 17 (API 37, stable June 2026), Windows 11 24H2/25H2.
**Scope:** A platform-agnostic phone↔PC continuity product (TeamViewer × Apple Continuity) over a direct link, covering three capability groups: (1) bidirectional remote view/control, (2) responsibility routing — splitting one session's I/O across devices, (3) live handoff of active sessions between devices.

**How to read the verdicts:** every feasibility claim names the OS API or protocol that gates it. Verdicts are one of **buildable**, **buildable-with-constraints** (constraint named), or **blocked** (blocker named). Claims that rest on an unverified source or an inference are labeled **[UNVERIFIED]** inline and collected in the appendix.

---

## 1. Recommendation: build the MVP on Android + Windows

**Target Android (phone) ↔ Windows (PC) for the MVP. Defer iOS entirely.** This is not a resourcing tradeoff you can revisit later by "porting" — iOS structurally forecloses two of the three capability groups, and no amount of engineering or entitlement paperwork changes that today.

### What iOS forecloses vs. what Android permits

| Capability the product depends on | iOS | Android |
|---|---|---|
| **PC → phone remote control** (inject touch/keys) | **Blocked.** No event-injection API exists in the iOS SDK. No MDM remote-control command. No accessibility injection path. TeamViewer and AnyDesk both ship **view-only** on iOS and say so plainly in their own KBs. Apple's own iPhone Mirroring does it, but it is private API — and is *withheld from the EU*. | **Buildable-with-constraints** via `AccessibilityService.dispatchGesture()` / `performGlobalAction()` — the same path TeamViewer's Universal Add-On uses. Constraints in §2.1. |
| **Cellular call audio** (capture or reroute) | **Blocked.** iOS has never exposed the cellular call stream to any app. `AVAudioSession` is *interrupted* by an incoming call. CallKit is VoIP-only and cannot answer/place carrier calls. | **Blocked** for interception (`CAPTURE_AUDIO_OUTPUT` / `SYSTEM_CALL_STREAMING` are system-only), but call *handoff* is **buildable** via the OS Bluetooth HFP path (§2.3). |
| **Live handoff of an active call to the PC** | **Blocked** for cellular. Continuity call handoff is Apple-account-private, no public API. Only your *own* VoIP call can be handed off, via your own signaling. | **Buildable** for the app's own VoIP audio, and for cellular calls by pairing the PC as a Bluetooth hands-free unit. |
| **Phone screen → PC (view)** | Buildable but user-initiated-only (ReplayKit); dies on lock/incoming call. | Buildable-with-constraints (MediaProjection); dies on screen lock. |
| **Persistent background phone↔PC link** | **No sanctioned daemon.** `voip` background mode deprecated since iOS 10. Best available is push-to-wake → user-initiated foreground session. | **Buildable.** `connectedDevice` foreground-service type + Companion Device Manager Doze exemptions give a persistent, resilient link. |

**The decisive point:** the product's identity is *bidirectional control + moving a live call between devices*. On iOS, the "control" direction into the phone is impossible and the "call" is untouchable. An iOS build would be a view-only screen-share with a VoIP-only calling story — a different, weaker product wearing the same name. **EU DMA remedies do not rescue this**: the Article 6(7) decisions (March 2025) open accessory pairing, notification forwarding, peer-to-peer Wi-Fi, and (by end-2026) media casting — but explicitly *not* screen control, call-audio access, or system-audio capture, and only in the EU. [UNVERIFIED: whether a Windows PC qualifies as a "connected device" under 6(7) is an inference, not a regulator finding.]

Windows is the unconstrained side of the pair: screen capture, input injection, and audio capture are all solved in documented APIs. The only Windows friction is presenting a *virtual* audio device (§2.2), which needs a signed driver — a cost, not a wall.

**Sequencing:** Android + Windows first. Revisit iOS only as a **view-only + own-VoIP companion** once the core product exists, and only if the market demands it. Do not let iOS parity constrain the Android/Windows architecture.

---

## 2. Subsystem decomposition

Feasibility is **not uniform across the three groups**. Group 1 is buildable with attended-session constraints. Group 2 is the one that partially collapses on contact with the platform. Group 3 is buildable if you stop trying to intercept audio and instead delegate to the OS.

### 2.1 Remote view/control (bidirectional)

**Hard problem:** Two asymmetric pipes. Phone→PC is *screen capture + encode + input replay on Windows*. PC→phone is *screen capture on Windows + input injection into Android*. The injection direction is where the platform fights you.

**Gating APIs / protocols:**

| Direction | Capture | Inject | Gate |
|---|---|---|---|
| Phone → PC | Android **MediaProjection** (`createScreenCaptureIntent` → `getMediaProjection` → `createVirtualDisplay`) | Windows **SendInput** | MediaProjection consent + FGS + screen-lock teardown |
| PC → phone | Windows **Windows.Graphics.Capture** | Android **AccessibilityService** (`dispatchGesture`, `performGlobalAction`, `AccessibilityNodeInfo.performAction`) | Accessibility Play policy + Restricted Settings + Advanced Protection Mode |

**Constraints that shape the product:**

- **MediaProjection is attended-only.** Since Android 15 QPR1 the projection **auto-stops when the screen locks**, and every session needs a fresh on-device consent tap (reusing the result Intent throws `SecurityException` on targetSdk 34+). A `mediaProjection` foreground service is mandatory and **cannot be started from `BOOT_COMPLETED`**. Net: reliable for *attended, screen-on* mirroring; **not** viable for "leave my phone at home and drive it from my PC."
- **AccessibilityService is the only non-root injection path — and it is politically hot.** It works today (TeamViewer's Universal Add-On is the existence proof, live on Play). But: it requires a Play policy declaration + prominent disclosure; sideloaded builds hit **Restricted Settings** friction (the toggle is greyed out); and **Android 17's Advanced Protection Mode hard-blocks any accessibility service not flagged as a genuine assistive tool, auto-revoking already-granted permission with no user override.** AAPM is opt-in today, but it is the clear direction of travel and names remote-control tools as a target category.
- **Windows control is a solved pattern with one sharp edge.** `SendInput` from a signed, `%ProgramFiles%`-installed, `uiAccess="true"` helper can drive any window. The **secure desktop** (UAC prompt, lock screen, Ctrl+Alt+Del) is off-limits to `SendInput`; remote-desktop products handle it with a SYSTEM service that detects the input-desktop switch and re-attaches a helper into `Winsta0\Winlogon`. [UNVERIFIED: a widely-circulated claim that a "January 2026 Windows update" blocks remote input into credential dialogs cites no KB/CVE and appears AI-fabricated — do not architect around it, but confirm independently.]

**Verdict:**
- Phone→PC view + PC-side control of the mirror: **buildable.**
- PC→phone control: **buildable-with-constraints** — constraint is *AccessibilityService policy exposure + AAPM erosion + attended-only capture.* This capability has a real medium-term durability risk and should be built behind a capability flag you can degrade to view-only.

### 2.2 Responsibility routing (split one session's I/O across devices)

This is the group that does not survive contact with the platform in the form the concept imagines it. The canonical example — *"a call using the phone's mic but the PC's speakers"* — is defeated **twice over**: once by the missing virtual-audio primitive, and again, more fundamentally, by physics.

**Hard problem A — there is no virtual audio device on either OS without privilege:**

- **Android:** an app cannot route *another* app's output to a chosen device. `setPreferredDevice()` is per-object, in-process only. There is **no public API to register a virtual audio sink or source** — `AudioPolicy`/`AudioMix` is `@SystemApi` + signature permission. A **virtual microphone** (PC mic feeding other Android apps) is likewise root/Xposed-only. The privileged capability that *does* all this — `COMPANION_DEVICE_APP_STREAMING` (virtual displays, input injection, mic/camera substitution) — is **restricted to preinstalled priv-apps**. This is the actual moat behind Phone Link / Link to Windows.
- **Windows:** presenting a virtual mic/speaker to other apps **requires a signed kernel-mode driver.** No user-mode API creates an audio endpoint (APOs attach to *existing* endpoints; ACX is KMDF). Capture is easy (WASAPI loopback, per-process loopback on build 20348+); *creating a device* is not.

**Hard problem B — distributed acoustic echo cancellation, which no shipping product solves:**

Even if you had virtual devices everywhere, splitting the microphone and loudspeaker across two devices **breaks echo cancellation**. AEC requires the playback reference and the mic signal to be time-aligned on a *single clock*. Two devices have two crystals; their sample rates differ by ~100 ppm or more, so the adaptive filter's alignment drifts by a full sample every ~200 ms and the filter **diverges within seconds**. Add the variable network delay in the reference path and you have exactly the condition AEC handles worst.

The industry does not solve this — it *avoids* it. **Microsoft Teams "companion mode"** — the closest existing analogue — automatically **mutes the speaker and mic on the second device** rather than attempt cross-device AEC. Conference hardware that splits transducers puts everything on one shared clock domain (Dante/AES67 + PTP), which is not available to a consumer app over the internet.

**Gating:** Android `AudioPolicy`/`AudioMix` (@SystemApi), `COMPANION_DEVICE_APP_STREAMING` (priv-app); Windows ACX/KMDF + WHCP driver signing; and the physics of sample-rate offset (SRO) documented in ITU/AEC literature.

**Verdict:**
- Move the **entire** audio loop (both mic and speaker) to one device, and route the *media/output* stream to the other: **buildable** (media audio via Android AudioPlaybackCapture + Windows loopback/virtual sink).
- **Split the acoustic loop across devices for a full-duplex call (phone mic + PC speaker): effectively blocked** for v1 — blocked by the virtual-device gap *and* undermined by distributed AEC. Shipping it means a multi-engineer-month SRO-compensated DSP effort with an uncertain outcome; even then, a Bluetooth headset on either end blows the ITU-T G.114 latency budget. **Recommendation: declare split mic/speaker unsupported and route by "which device owns the audio," not "which device owns each transducer."**

### 2.3 Live handoff of active sessions (calls, audio)

**Hard problem:** Move a live session from device A to device B with no audible gap. What "the session" *is* determines whether this is trivial or impossible.

- **The app's own VoIP call:** trivial-ish. It's your `AVAudioSession` / your `AudioRecord`+`AudioTrack`; you re-negotiate the media path over your own signaling and tear down the old leg. **Buildable.**
- **A cellular (carrier) call:** you cannot touch the audio. On Android, `AudioSource.VOICE_CALL` needs `CAPTURE_AUDIO_OUTPUT` (signature|privileged); the cross-device call-streaming plumbing added in Android 14 is gated behind the **`SYSTEM_CALL_STREAMING`** role, held by Google Play Services, not grantable to you. The cellular audio path is modem↔codec hardware and never crosses the app sandbox.
- **The only legitimate cellular-handoff path is the one Phone Link uses:** the **PC pairs as a Bluetooth HFP hands-free unit**, the phone is the Audio Gateway, and the *OS Bluetooth stack* carries the call audio. Your Android app does signaling and UI; it never handles PCM. **Do not try to be the HFP unit on the Windows side yourself** — `PhoneLineTransportDevice` is call-control-only and its `RegisterApp()` has been broken for third parties since Windows 11 22H2 while Phone Link (privileged) keeps working. Let the OS own HFP; your PC app pairs as a standard hands-free device and presents the audio through the virtual endpoint from §2.2.

**Gating:** Android `SYSTEM_CALL_STREAMING` (system role) [UNVERIFIED-BY-PRIMARY-SOURCE — confirm against AOSP `packages/services/Telecomm` before design lock]; Android/Windows Bluetooth HFP profile ownership; your own signaling for VoIP.

**Verdict:**
- Own-VoIP handoff: **buildable.**
- Cellular-call handoff via OS Bluetooth HFP: **buildable-with-constraints** — constraint is *you ride the OS Bluetooth pairing and never touch call audio; the PC must be pairable as an HFP hands-free device.*
- Cellular-call handoff by *intercepting* audio: **blocked.**

### Subsystem verdict summary

| Subsystem | Verdict | Named constraint / blocker |
|---|---|---|
| 1. Phone→PC view & control | **Buildable** | MediaProjection attended-only (dies on lock) |
| 1. PC→phone control | **Buildable-with-constraints** | AccessibilityService: Play policy + Restricted Settings + A17 Advanced Protection Mode erosion |
| 2. Media/output audio to the other device | **Buildable** | AudioPlaybackCapture excludes VoIP usage; Windows virtual sink needs signed driver |
| 2. Split mic/speaker for a full-duplex call | **Blocked (v1)** | No virtual-device API + distributed AEC diverges (SRO/clock drift); no product solves it |
| 3. Own-VoIP handoff | **Buildable** | — (your own signaling) |
| 3. Cellular-call handoff | **Buildable-with-constraints** | Only via OS Bluetooth HFP; audio interception is system-role-gated |

---

## 3. Phased MVP boundary

**Cut-line rationale:** Phase 1 ships exactly what *stock-platform, Play-Store-distributable, no-OEM-deal* APIs allow, minus anything that requires a research-grade DSP bet. Everything on the far side of the line requires either an OEM preload partnership (the `COMPANION_DEVICE_APP_STREAMING` moat), a multi-month uncertain effort (distributed AEC), or a platform that forecloses the feature (iOS). Drawing the line here means Phase 1 is *shippable by a normal team through normal channels* and every excluded item has a concrete, named reason.

### Phase 1 ships

- **Android ↔ Windows only.**
- **Attended bidirectional remote view + control:** phone screen → PC (MediaProjection), PC screen → phone view, PC→phone control (AccessibilityService add-on), PC-side control of the phone mirror.
- **Media/output audio streaming** between devices (music/video/game audio → PC via AudioPlaybackCapture; PC audio → phone via WASAPI loopback).
- **Whole-loop audio handoff:** move the *entire* audio session to one device; route by device ownership, not per-transducer.
- **Own-VoIP call handoff** via app signaling.
- **Cellular-call handoff via OS Bluetooth HFP** (PC pairs as hands-free unit) — *if* Bluetooth HFP integration lands in the Phase 1 budget; otherwise Phase 1.5.
- **Secure device pairing** over LAN / direct P2P with QR + Noise session (§4).
- **Persistent presence** via Companion Device Manager (`connectedDevice` FGS + Doze exemptions).

### Phase 1 deliberately excludes

| Excluded | Why (the cut-line reason) |
|---|---|
| **Split mic/speaker for full-duplex calls** | Distributed AEC diverges; no virtual-device API. Research-grade, uncertain, off the critical path (§2.2). |
| **Cellular call-audio interception / recording** | System-role-gated on Android, impossible on iOS. Blocked, not deferred. |
| **Unattended / always-on phone mirroring** | MediaProjection auto-stops on lock + re-consent per session. No stock API path. |
| **iOS** | Forecloses control + call handoff (§1). |
| **Phone-Link-grade app streaming / virtual mic** | Requires `COMPANION_DEVICE_APP_STREAMING` — preinstalled priv-app only. Needs an OEM deal. |
| **Sideload-first distribution of the control add-on** | Restricted Settings + AAPM friction; Play distribution is the supported path. |

### Phase 2+ (gated on external decisions, not just engineering)

- OEM preload partnership → unlock the streaming/virtual-mic tier.
- The distributed-AEC bet, *only* if split-device calling proves to be a must-have.
- iOS view-only + own-VoIP companion.
- EU DMA interoperability request for expanded capability (EU-only, speculative, 6–18 month process).

---

## 4. Recommended stack & transport

One recommendation per choice-point, with the strongest rejected alternative.

### Pairing & session security → **per-device X25519 keypair + QR fingerprint transfer + Noise_IK session + TOFU pinning**

Each device generates a long-term X25519/Ed25519 keypair on first run; the **device ID is the fingerprint of the public key** (Syncthing's model — identity *is* the key, nothing separate to revoke). The PC shows a QR encoding {public key, LAN addresses, nonce}; the phone scans it, so both sides know the other's key with no manual comparison. Session transport is **Noise_IK** (X25519 + ChaCha20-Poly1305 + BLAKE2s) — 1-RTT, mutual auth from known static keys, forward secrecy — exactly what WireGuard and Tailscale's control plane use. Trust-on-first-use with a visible fingerprint for MITM detection thereafter. No-camera fallback: a short code through **SPAKE2/CPace**, never a bare short-PIN DH.

**Rejected: short-PIN-only DH (the Moonlight/Sunshine 4-digit pattern).** A 4–6 digit secret in a plain Diffie-Hellman exchange is brute-forceable by an active LAN attacker. If a short secret is required for UX, it must go through a PAKE so each guess costs an online round-trip.

### NAT traversal → **full ICE (host + STUN + your own TURN), own rendezvous server, LAN-first**

Standard ICE with mDNS/host candidates for the common same-network case, STUN for server-reflexive, and your own TURN as relay-of-last-resort, coordinated by your own signaling/rendezvous server. This is functionally what RustDesk does (rendezvous + concurrent hole-punch + relay fallback) and it fits a clean 2-device topology. Budget ~5–15% of sessions relayed [UNVERIFIED as a number for this specific topology — extrapolated from libp2p DCUtR's ~70% direct-success measurement and Tailscale's qualitative claims].

**Rejected: embed WireGuard/Tailscale (headscale).** Genuinely close — it solves connectivity beautifully — but it needs a **TUN/TAP virtual adapter (another signed driver + UAC surface) on Windows**, it consumes Android's **single `VpnService` slot** (breaking every other VPN the user runs), and it gives you a *network*, not a *session* — you'd still build pairing, discovery, and signaling on top, and operate a coordination server anyway. Reconsider only if CGNAT/enterprise users dominate. **Also rejected: libp2p DCUtR** (~70% success, no integrated relay-of-last-resort, large P2P dependency you don't need for two devices).

### Streaming codec → **HEVC preferred, H.264 mandatory floor; AV1 only PC→phone; prioritize 4:4:4 chroma over codec generation**

Negotiate per-direction. HEVC gives ~30–40% better quality-per-bit than H.264 with near-universal hardware decode, and both directions have HEVC hardware encode. H.264 is the mandatory fallback floor. **AV1 only in the PC→phone direction** — Android mid-range SoCs lack AV1 hardware *encode* (Tensor G3 was the first phone SoC with it; Qualcomm has signalled it's skipping AV1 encode), so the phone→PC direction must not depend on it. For a *desktop continuity* product, **4:4:4 (or at least 4:2:2) chroma matters more than codec generation** — 4:2:0 destroys small text; prioritize it. [Note HEVC patent-pool exposure — get legal input before making it the shipped default; HEVC decode on Windows via D3D11/DXVA or vendor SDKs bypasses the Store "HEVC Video Extensions" requirement.]

**Rejected: AV1-first.** Phone-side hardware AV1 encode is absent on the mid-range, and AV1 encode latency at fast/real-time presets still trails HEVC. Consistent 2026 guidance: HEVC for low-latency real-time, AV1 for VOD.

### Audio routing layer → **Opus 1.6.x codec + WASAPI/AudioPlaybackCapture on the endpoints + a licensed signed virtual-audio driver on Windows**

**Codec: Opus 1.6.x, 10 ms frames, `OPUS_APPLICATION_VOIP`, FEC + DRED on** for the call path. There is no successor — Opus 1.6 (Dec 2025) added bandwidth extension and improved DRED (ML-based loss recovery). Latency budget anchors on ITU-T G.114 (≤150 ms one-way is transparent); a single-device audio loop lands ~55–150 ms with the jitter buffer as the main tuning knob.

**Virtual-device layer (Windows):** to present remote audio as a selectable mic/speaker to other Windows apps you **must** ship a signed kernel driver. **License an existing one with a user-mode control API — Thesycon TVirtAudio (commercial) or VirtualDrivers/Virtual-Audio-Driver (open source)** — installed by your admin installer. Do **not** build and WHCP-certify your own ACX driver for v1: the **April 2026 WHCP change** removed cross-signed driver trust and now requires an EV cert + Partner Center submission.

**RTC framework:** use **libwebrtc** as the transport + audio stack (ICE + DTLS-SRTP + SCTP data channels + Opus + AEC3 on the single-device loop, one codebase on both platforms), with **external hardware video encoder factories** wrapping NVENC/AMF/QSV on Windows and `MediaCodec` on Android. Carry input events on an **unreliable, unordered** data channel (`maxRetransmits: 0`) so a lost packet doesn't head-of-line-block the cursor.

**Rejected: a pure user-mode / APO audio approach.** Architecturally impossible — APOs attach to existing endpoints and cannot create a new mic/speaker. **Rejected RTC alternative: Pion** — excellent protocol stack, but server-side: no client-side media capture and no hardware-codec integration, which is exactly what this product needs on the endpoints.

### Stack summary

| Choice point | Recommendation | Strongest rejected alternative |
|---|---|---|
| Pairing | X25519 keypair + QR fingerprint + Noise_IK + TOFU | Short-PIN-only DH (brute-forceable) |
| NAT traversal | ICE + STUN + own TURN, own rendezvous | Embedded WireGuard/Tailscale (driver + VpnService cost) |
| Video codec | HEVC preferred / H.264 floor / AV1 PC→phone; 4:4:4 | AV1-first (no phone HW encode) |
| Audio codec | Opus 1.6.x, 10 ms, FEC+DRED | LC3plus (BT-LE-Audio-scoped, licensed) |
| Audio routing (Win virtual device) | License a signed driver (Thesycon / open-source) | APO / user-mode (impossible) |
| RTC framework | libwebrtc + external HW encoder factories | Pion (no client media/HW codec) |

---

## 5. Open questions only you can answer

These change the spec's shape and I can't resolve them from the platform APIs:

1. **Is split-device calling (phone mic + PC speaker, or vice versa) a must-have, or a nice-to-have?** If must-have, the distributed-AEC problem (§2.2) moves onto the critical path — a multi-engineer-month DSP effort (SRO-compensated AEC + long adaptive filter + half-duplex fallback) with an uncertain outcome, gated behind a "beta / may echo" label. My recommendation is to declare it unsupported for v1 and route audio by whole-device ownership. Confirm you're comfortable with that cut.

2. **Target geography — is the EU a priority market?** The EU DMA interoperability regime (accessory pairing, notification forwarding, P2P Wi-Fi, end-2026 media casting) is real but EU-only, and it does *not* open control or call audio. It mainly matters if you later add an iOS companion or pursue a formal interoperability request.

3. **Appetite for an OEM preload partnership?** The entire Phone-Link-grade tier — virtual microphone, app streaming, mic/camera substitution — is locked behind Android's `COMPANION_DEVICE_APP_STREAMING` role, available **only to preinstalled priv-apps**. Without an OEM deal you are permanently capped below Phone Link's fidelity. Is that a Phase 2 ambition or out of scope?

4. **Distribution channel: consumer Play Store, or enterprise/MDM?** This decides how much AccessibilityService and Restricted-Settings/AAPM friction you inherit (§2.1). Enterprise/managed devices can sidestep some of it; a consumer Play app cannot, and faces the Advanced Protection Mode erosion risk head-on.

5. **Willingness to ship a signed kernel driver and, later, pursue WHCP?** v1 can license a third-party signed virtual-audio driver (Thesycon or open-source). But if you ever need dynamic multi-endpoint routing you'll need your own driver, an EV cert, and a WHCP submission (post-April-2026 rules). Is that an acceptable future cost?

6. **Latency vs. reach priority for the transport.** LAN-first ICE optimizes the common case; heavy CGNAT/enterprise-firewall users would tilt the "embedded WireGuard" decision (§4). Do you expect a meaningful share of users behind symmetric NAT / carrier-grade NAT?

---

## Appendix: unverified & low-confidence claims

Flagged so nothing downstream treats them as settled fact:

- **iOS ReplayKit ~50 MB broadcast-extension memory cap** — consistently reported by developers/SDK vendors, **never stated in Apple docs**. Treat as an empirical engineering constraint.
- **iOS DRM content blanked/muted in ReplayKit capture** — widely-known behavior, no citable Apple statement located.
- **"No iOS accessibility event-injection API exists"** — a negative claim; no single source affirms it, but no such API is in the SDK and every remote-access vendor independently states *on-device* control is impossible. High practical confidence. This scopes only what an on-device iOS app can do; it does **not** cover a **host-tethered** driver: a PC can drive an iPhone over the LAN via Apple's own WebDriverAgent (real taps/swipes/text), which tether implements as an owner-operated, opt-in subsystem — see `docs/IOS-CONTROL.md`. `IOS_CAPS.remoteControl.controllableVia` stays `'none'` because it models *peer* controllability, not this out-of-band host path.
- **Android `SYSTEM_CALL_STREAMING` role specifics** — sourced from XDA reporting on AOSP, not a primary developer.android.com page. **Confirm against AOSP `packages/services/Telecomm` before design lock.**
- **Whether any OEM ships Android 17 Advanced Protection Mode enabled by default** — unconfirmed; today it is opt-in.
- **Windows "January 2026 credential-UI hardening" blocking remote input** — cites no KB/CVE; appears AI-fabricated. **Do not design around it.**
- **`PhoneLineTransportDevice` being privileged vs. merely allow-listed** for Phone Link — observable outcome (third-party `RegisterApp()` broken since 22H2) is confirmed; the mechanism is not.
- **TURN relay rate ~5–15%** — extrapolated, not measured for this topology.
- **Whether a Windows PC qualifies as an EU DMA Art. 6(7) "connected device"** — an inference, not a regulator finding.
- **iOS 27 contents** (Google Cast defaults, full background-execution remedy) — rumor + regulatory deadline only; nothing shipped or documented as of Aug 2026.
