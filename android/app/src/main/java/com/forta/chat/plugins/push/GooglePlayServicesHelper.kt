package com.forta.chat.plugins.push

import android.content.Context
import android.util.Log
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

/**
 * Detect whether Google Play Services is present and usable on the
 * current device (WEE-31).
 *
 * Background: forta.chat ships Firebase Cloud Messaging, but a sizeable
 * fraction of our user base runs on devices that have no working GMS:
 *   - Huawei post-2019 (HMS-only)
 *   - GrapheneOS / CalyxOS / LineageOS without microG
 *   - Aurora OS (Russian Sailfish fork)
 *   - Older Xiaomi/Realme units where the user disabled "Google Play
 *     Services" in MIUI settings
 *
 * On those devices, calling `FirebaseMessaging.getInstance().token` or
 * (more importantly) `PushNotifications.register()` through the
 * Capacitor plugin throws an `IOException("SERVICE_NOT_AVAILABLE")` or
 * a `MissingResourceException` from inside the FCM SDK — and the JS
 * side currently awaits `PushNotifications.register()` without a
 * catch, so the unhandled rejection propagated all the way to the
 * webview boot path and crashed the app on cold start. This helper
 * lets both Kotlin and JS short-circuit those code paths cleanly.
 */
object GooglePlayServicesHelper {

    private const val TAG = "GmsHelper"

    /**
     * @return `true` only when Play Services is installed and the
     * version on disk meets the minimum required by our Firebase SDK.
     * `false` for every "missing / outdated / disabled / invalid"
     * outcome so callers can branch on a single boolean.
     */
    fun isAvailable(context: Context): Boolean {
        return statusCode(context) == ConnectionResult.SUCCESS
    }

    /**
     * @return one of the [ConnectionResult] codes
     * ([SUCCESS][ConnectionResult.SUCCESS],
     * [SERVICE_MISSING][ConnectionResult.SERVICE_MISSING],
     * [SERVICE_DISABLED][ConnectionResult.SERVICE_DISABLED], etc.).
     * Always wrapped in a defensive try/catch — the static
     * `GoogleApiAvailability.getInstance()` itself can hit a
     * `NoClassDefFoundError` on stripped HMS-only firmwares where
     * the platform's Play Services stub class is absent.
     */
    fun statusCode(context: Context): Int {
        return try {
            val gma = GoogleApiAvailability.getInstance()
            val code = gma.isGooglePlayServicesAvailable(context)
            if (code != ConnectionResult.SUCCESS) {
                Log.w(
                    TAG,
                    "Play Services unavailable: code=$code (${gma.getErrorString(code)})",
                )
            }
            code
        } catch (t: Throwable) {
            // Class linker failure on Huawei/Aurora — treat as
            // missing rather than crashing the caller.
            Log.e(TAG, "[callee-crash-guard] GoogleApiAvailability lookup threw", t)
            ConnectionResult.SERVICE_INVALID
        }
    }
}
