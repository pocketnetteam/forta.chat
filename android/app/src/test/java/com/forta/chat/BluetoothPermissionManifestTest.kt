package com.forta.chat

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: on Android 7–11 AudioRouter's getProfileConnectionState threw
 * SecurityException without the legacy BLUETOOTH permission, so a headset was never offered.
 */
class BluetoothPermissionManifestTest {
    @Test
    fun legacyBluetoothPermissionIsDeclaredUpToApi30() {
        val manifest = listOf("src/main/AndroidManifest.xml", "android/app/src/main/AndroidManifest.xml")
            .map { File(it) }.first { it.exists() }.readText()
        assertTrue(
            Regex("""android\.permission\.BLUETOOTH"\s+android:maxSdkVersion="30"""").containsMatchIn(manifest),
        )
    }
}
