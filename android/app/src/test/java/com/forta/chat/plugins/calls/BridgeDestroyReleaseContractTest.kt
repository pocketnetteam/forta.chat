package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: a renderer-death recreate() or any other destroy of the bridge during a call
 * disposed the peer connections but left the Telecom connection ACTIVE; while the process
 * lived, every later call was treated as busy. CallPlugin must release it on destroy.
 */
class BridgeDestroyReleaseContractTest {

    @Test
    fun handleOnDestroyReleasesTheLiveCall() {
        val source = listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallPlugin.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallPlugin.kt",
        ).map { File(it) }.first { it.exists() }.readText()
        val start = source.indexOf("override fun handleOnDestroy()")
        assertTrue(start >= 0)
        val body = source.substring(start, source.indexOf("super.handleOnDestroy()", start))
        assertTrue(body.contains("CallConnectionService.releaseOnTaskRemoved()"))
        assertTrue(body.contains("isChangingConfigurations"))
    }
}
