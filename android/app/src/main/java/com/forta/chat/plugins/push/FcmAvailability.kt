package com.forta.chat.plugins.push

import com.google.android.gms.common.ConnectionResult

/**
 * Whether FCM can deliver on this device.
 *
 * The check used to be BuildConfig.FIREBASE_ENABLED alone (was google-services.json
 * bundled at build time). On Huawei and other phones without Google Play Services
 * registration "succeeded" and no token ever came, so push silently never worked
 * (audit W2B-03).
 */
object FcmAvailability {
    /**
     * Play Services states in which FCM never delivers: absent, turned off, or broken.
     * An update-required or updating Play Services usually still delivers, so it does
     * not block registration.
     */
    fun playServicesUsable(status: Int): Boolean = when (status) {
        ConnectionResult.SERVICE_MISSING,
        ConnectionResult.SERVICE_DISABLED,
        ConnectionResult.SERVICE_INVALID -> false
        else -> true
    }

    fun fcmUsable(firebaseEnabled: Boolean, playServicesStatus: Int): Boolean =
        firebaseEnabled && playServicesUsable(playServicesStatus)
}
