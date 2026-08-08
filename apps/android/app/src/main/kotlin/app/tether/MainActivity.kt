package app.tether

import android.app.Activity
import android.os.Bundle

/**
 * Entry point. Real UI (pairing QR scan, session controls, capability toggles)
 * is TODO. The first milestone (see apps/android/README.md) only needs this to
 * host the pairing flow and start LinkService.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // TODO: render pairing screen; on pair, start LinkService and connect
        //       SignalingClient; on "share screen", request MediaProjection consent
        //       then start ScreenCaptureService.
    }
}
