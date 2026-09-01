package app.tether.control

import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot

/**
 * PC -> phone control: decodes the shared input-event schema
 * (packages/protocol/src/input.ts) and drives [RemoteControlService].
 *
 * This is the lib-agnostic seam for "PC controls Android": the (future) WebRTC
 * DataChannel observer just forwards each received text frame to [onEvent]. It
 * carries NO WebRTC dependency, so it can be unit-tested on its own.
 *
 * Coordinates arrive normalized 0..1 of the shared frame; we scale to screen
 * pixels. Android has no continuous-pointer injection, so a pointer press+release
 * is synthesized into a discrete tap (small displacement) or swipe/drag (large):
 * `pdown` records the start, `pup` decides tap vs swipe. `pmove` is folded into
 * the pending gesture's end point. `key` events have no stock injection path and
 * are ignored (typing rides `text`).
 */
class InputReceiver(
    private val screenWidth: Int,
    private val screenHeight: Int,
    /** Wall-clock in ms; injectable for tests. */
    private val now: () -> Long = { System.currentTimeMillis() },
) {
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var downAt = 0L
    private var pressed = false

    /** Feed one DataChannel text frame (a JSON-encoded InputEvent). */
    fun onEvent(json: String) {
        val ev = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        when (ev.optString("i")) {
            "pdown" -> {
                downX = px(ev.optDouble("x"))
                downY = py(ev.optDouble("y"))
                lastX = downX
                lastY = downY
                downAt = now()
                pressed = true
            }
            "pmove" -> {
                if (pressed) {
                    lastX = px(ev.optDouble("x"))
                    lastY = py(ev.optDouble("y"))
                }
            }
            "pup" -> {
                if (!pressed) return
                pressed = false
                lastX = px(ev.optDouble("x"))
                lastY = py(ev.optDouble("y"))
                dispatchGesture()
            }
            "wheel" -> {
                // Wheel -> a vertical swipe from screen center (a scroll gesture).
                val svc = RemoteControlService.instance ?: return
                val dy = ev.optDouble("dy")
                val cx = screenWidth / 2f
                val cy = screenHeight / 2f
                // Content scrolls opposite the wheel sign; a small fixed throw per event.
                val throw_ = if (dy > 0) -screenHeight * 0.25f else screenHeight * 0.25f
                svc.swipe(cx, cy, cx, (cy + throw_).coerceIn(0f, screenHeight - 1f), 120)
            }
            "text" -> {
                val text = ev.optString("text")
                if (text.isNotEmpty()) RemoteControlService.instance?.setText(text)
            }
            "nav" -> when (ev.optString("action")) {
                "back" -> RemoteControlService.instance?.back()
                "home" -> RemoteControlService.instance?.home()
                "recents" -> RemoteControlService.instance?.recents()
            }
            // "key": no stock keystroke injection on non-root Android — ignored.
        }
    }

    private fun dispatchGesture() {
        val svc = RemoteControlService.instance ?: return
        val dist = hypot((lastX - downX).toDouble(), (lastY - downY).toDouble())
        val heldMs = now() - downAt
        if (dist < TAP_SLOP && abs(heldMs) < TAP_MAX_MS) {
            svc.tap(downX, downY)
        } else {
            svc.swipe(downX, downY, lastX, lastY, heldMs.coerceIn(60, 600))
        }
    }

    private fun px(x: Double): Float = (x.coerceIn(0.0, 1.0) * screenWidth).toFloat()
    private fun py(y: Double): Float = (y.coerceIn(0.0, 1.0) * screenHeight).toFloat()

    private companion object {
        const val TAP_SLOP = 12.0 // px: below this a press+release is a tap, not a drag
        const val TAP_MAX_MS = 400L
    }
}
