package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: rotating the phone (or a dark-mode switch) while a call rang
 * recreated IncomingCallActivity. The old instance's onDestroy stopped the
 * ringer, which forgot the user's volume-key silence, and the new one rang
 * again with a fresh 30 s deadline.
 */
class RingerRecreateContractTest {

    private fun read(vararg paths: String) = paths.map { File(it) }.first { it.exists() }.readText()

    @Test
    fun manifestKeepsTheRingerScreenAcrossRotation() {
        val manifest = read("src/main/AndroidManifest.xml", "android/app/src/main/AndroidManifest.xml")
        val start = manifest.indexOf("com.forta.chat.plugins.calls.IncomingCallActivity")
        val entry = manifest.substring(start, manifest.indexOf("/>", start))
        assertTrue(entry.contains("android:configChanges=\"orientation|screenSize"))
        assertTrue(entry.contains("uiMode"))
    }

    @Test
    fun recreationDoesNotStopTheRinger() {
        val source = read(
            "src/main/java/com/forta/chat/plugins/calls/IncomingCallActivity.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/IncomingCallActivity.kt",
        )
        val start = source.indexOf("override fun onDestroy()")
        val body = source.substring(start, source.indexOf("super.onDestroy()", start))
        assertTrue(body.contains("currentInstance === this && !isChangingConfigurations"))
    }
}
