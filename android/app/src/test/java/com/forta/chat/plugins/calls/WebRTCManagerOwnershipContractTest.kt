package com.forta.chat.plugins.calls

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: WebRTCPlugin.handleOnDestroy disposed and nulled the shared
 * static manager whichever plugin instance had created it. A bridge loaded
 * before the old one was destroyed lost its manager, and every later WebRTC
 * call failed with "Manager not initialized" until a restart.
 */
class WebRTCManagerOwnershipContractTest {

    @Test
    fun destroyReleasesOnlyItsOwnManager() {
        val source = listOf(
            "src/main/java/com/forta/chat/plugins/webrtc/WebRTCPlugin.kt",
            "android/app/src/main/java/com/forta/chat/plugins/webrtc/WebRTCPlugin.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        val start = source.indexOf("override fun handleOnDestroy()")
        val body = source.substring(start, source.indexOf("super.handleOnDestroy()", start))
        assertTrue(body.contains("if (manager === own) manager = null"))
        assertFalse(body.contains("manager?.dispose()"))
    }
}
