package app.tether.presence

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * The persistent phone<->PC link (SPEC §2.8). Foreground service of type
 * `connectedDevice`. Owns the SignalingClient connection and the Noise session
 * to the paired PC, and stays alive across Doze via the Companion Device Manager
 * background exemptions declared in the manifest.
 *
 * This is the always-available control channel. Heavy media (screen, audio) is
 * started on demand by its own attended session and torn down after.
 */
class LinkService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // TODO: startForeground(connectedDevice notification); open SignalingClient;
        //       maintain Noise session; expose a binder for the UI/session layer.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
