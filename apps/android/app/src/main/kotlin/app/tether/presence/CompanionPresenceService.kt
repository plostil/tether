package app.tether.presence

import android.companion.CompanionDeviceService
import android.companion.AssociationInfo

/**
 * Bound by the system when the paired PC enters/leaves BLE range (SPEC §2.8).
 * Use the Android 16+ ObservingDevicePresenceRequest API to register interest;
 * onDeviceAppeared -> ensure LinkService is up; onDeviceDisappeared -> allow it
 * to wind down. This is the intended "wake when my PC is nearby" primitive and
 * the best stock substitute for an always-on socket.
 */
class CompanionPresenceService : CompanionDeviceService() {
    override fun onDeviceAppeared(association: AssociationInfo) {
        // TODO: start/refresh LinkService for this association.
    }

    override fun onDeviceDisappeared(association: AssociationInfo) {
        // TODO: let LinkService wind down if no active session.
    }
}
