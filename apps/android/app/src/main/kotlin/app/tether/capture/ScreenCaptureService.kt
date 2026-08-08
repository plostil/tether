package app.tether.capture

import android.app.Service
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.IBinder

/**
 * Phone screen -> PC (SPEC §2.1). Attended-only by platform design:
 *   - Requires a fresh per-session user consent Intent (targetSdk 34+).
 *   - Runs as a foreground service of type `mediaProjection`.
 *   - CANNOT be started from BOOT_COMPLETED (Android 15+).
 *   - The projection auto-stops when the screen locks (Android 15 QPR1+):
 *     we surface that as a normal session end, not an error.
 *
 * Do not attempt to work around the lock teardown — there is no stock API for
 * unattended capture, and pretending otherwise leaks into a broken UX.
 */
class ScreenCaptureService : Service() {

    private var projection: MediaProjection? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 1. startForeground(...) with a mediaProjection-typed notification FIRST.
        // 2. Rebuild the MediaProjection from the consent result Intent passed in.
        // 3. createVirtualDisplay(...) into a Surface fed to the encoder.
        // 4. Register MediaProjection.Callback; onStop() -> tear down + notify peer.
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, 0) ?: 0
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val mpm = getSystemService(MediaProjectionManager::class.java)
        if (resultCode != 0 && resultData != null) {
            projection = mpm.getMediaProjection(resultCode, resultData).also { mp ->
                mp.registerCallback(object : MediaProjection.Callback() {
                    override fun onStop() { stopSelf() } // lock / user-revoke / call
                }, null)
                // TODO: createVirtualDisplay -> Surface -> HW H.264/HEVC encoder ->
                //       WebRTC video track (SPEC §4 codec policy).
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        projection?.stop()
        projection = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
    }
}
