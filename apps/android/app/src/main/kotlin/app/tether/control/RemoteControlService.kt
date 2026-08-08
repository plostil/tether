package app.tether.control

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.view.accessibility.AccessibilityEvent

/**
 * PC -> phone input injection (SPEC §2.1). This is the ONLY non-root path on
 * stock Android, and it is durability-risked: Google Play policy governs it, and
 * Android 17 Advanced Protection Mode can revoke it with no user override. The
 * app MUST degrade gracefully to view-only when this service is not enabled.
 *
 * This service replays input from a human operator at the paired PC. It does not
 * originate actions on its own — that keeps it inside Play's accessibility policy
 * (the autonomous-action prohibition explicitly exempts deterministic,
 * human-driven remote assistance).
 */
class RemoteControlService : AccessibilityService() {

    override fun onServiceConnected() {
        instance = this
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** Inject a tap at absolute screen coordinates. */
    fun tap(x: Float, y: Float, durationMs: Long = 40) {
        val path = Path().apply { moveTo(x, y) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
                .build(),
            null,
            null,
        )
    }

    /** Inject a swipe / drag. */
    fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long = 200) {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
                .build(),
            null,
            null,
        )
    }

    fun back() = performGlobalAction(GLOBAL_ACTION_BACK)
    fun home() = performGlobalAction(GLOBAL_ACTION_HOME)
    fun recents() = performGlobalAction(GLOBAL_ACTION_RECENTS)

    // TODO: text entry via focused-node ACTION_SET_TEXT or an accessibility IME.

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* not needed for replay */ }
    override fun onInterrupt() {}

    companion object {
        /** Non-null only while the user has the service enabled. */
        @Volatile
        var instance: RemoteControlService? = null
            private set

        val isControlAvailable: Boolean get() = instance != null
    }
}
