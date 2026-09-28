package com.forta.chat.plugins.push

import com.google.android.gms.common.ConnectionResult
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Audit W2B-03: FCM availability was the build flag alone, so on phones without
 * Google Play Services registration "succeeded" and no push ever arrived.
 */
class FcmAvailabilityTest {

    @Test
    fun missingDisabledOrBrokenPlayServicesBlockFcm() {
        assertFalse(FcmAvailability.fcmUsable(true, ConnectionResult.SERVICE_MISSING))
        assertFalse(FcmAvailability.fcmUsable(true, ConnectionResult.SERVICE_DISABLED))
        assertFalse(FcmAvailability.fcmUsable(true, ConnectionResult.SERVICE_INVALID))
    }

    @Test
    fun workingOrUpdatablePlayServicesKeepFcm() {
        assertTrue(FcmAvailability.fcmUsable(true, ConnectionResult.SUCCESS))
        assertTrue(FcmAvailability.fcmUsable(true, ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED))
        assertTrue(FcmAvailability.fcmUsable(true, ConnectionResult.SERVICE_UPDATING))
    }

    @Test
    fun aBuildWithoutFirebaseNeverRegisters() {
        assertFalse(FcmAvailability.fcmUsable(false, ConnectionResult.SUCCESS))
    }

    @Test
    fun thePluginAsksPlayServicesAtRunTime() {
        val relative = "com/forta/chat/plugins/push/PushDataPlugin.kt"
        val plugin = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
            .map { File(it) }.firstOrNull { it.exists() }?.readText() ?: error("$relative not found")
        assertTrue(plugin.contains("GoogleApiAvailabilityLight.getInstance().isGooglePlayServicesAvailable(context)"))
        assertTrue(plugin.contains("FcmAvailability.fcmUsable(com.forta.chat.BuildConfig.FIREBASE_ENABLED, status)"))
    }
}
