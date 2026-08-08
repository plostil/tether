# Open questions (decisions only the product owner can make)

These gate later phases and cannot be resolved from the platform APIs. Mirrors
SPEC §5; capture answers here as they land.

| # | Question | Impact if answered "yes"/"the hard way" | Recommendation | Status |
|---|---|---|---|---|
| 1 | Is split-device calling (phone mic + PC speaker) a must-have? | Moves distributed-AEC onto the critical path: multi-engineer-month, uncertain, "beta/may echo" (SPEC §2.2) | Declare unsupported for v1; route audio by whole-device ownership | **open** |
| 2 | Is the EU a priority market? | Pulls in DMA interoperability regime (EU-only; does not open control/call audio) | Ship Android+Windows globally; treat DMA as iOS-companion concern later | **open** |
| 3 | Appetite for an OEM preload partnership? | Unlocks `COMPANION_DEVICE_APP_STREAMING` (virtual mic, app streaming) — the Phone-Link tier | Phase 2 ambition; MVP is capped below Phone Link fidelity without it | **open** |
| 4 | Distribution: consumer Play Store vs enterprise/MDM? | Decides AccessibilityService + Restricted-Settings + A17 AAPM friction (SPEC §2.1) | Consumer Play for reach; accept AAPM durability risk + view-only fallback | **open** |
| 5 | Willing to ship a signed kernel driver, later pursue WHCP? | Own virtual-audio driver needs EV cert + Partner Center (post-April-2026) | v1: license a third-party signed driver; defer own-driver decision | **open** |
| 6 | Latency vs reach for transport — meaningful share behind CGNAT/symmetric NAT? | Tilts the "embedded WireGuard" call vs LAN-first ICE (SPEC §4) | LAN-first ICE + own TURN; revisit WireGuard only if CGNAT dominates | **open** |

## Things to re-verify before design lock (from SPEC appendix)

- Android `SYSTEM_CALL_STREAMING` role specifics — confirm against AOSP
  `packages/services/Telecomm` (currently XDA-sourced).
- Whether any OEM ships Android 17 Advanced Protection Mode enabled by default.
- The "January 2026 Windows credential-UI hardening" claim — appears fabricated;
  do not design around it, but confirm independently.
- ReplayKit ~50 MB extension cap (iOS, only relevant if/when an iOS companion ships).
