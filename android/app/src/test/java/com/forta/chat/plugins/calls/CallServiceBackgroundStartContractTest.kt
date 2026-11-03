package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression (Samsung, Android 14, 2026-10-05): updateCallStatus from JS while
 * the phone was locked and no call service ran crashed the process with
 * BackgroundServiceStartNotAllowedException on the CapacitorPlugins thread.
 * stop() — every call teardown — had the same unguarded startService, and an
 * instance created for a stale update stayed started.
 */
class CallServiceBackgroundStartContractTest {

    private val source = listOf(
        "src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
        "android/app/src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
    ).map { File(it) }.first { it.exists() }.readText()

    private fun body(of: String, until: String): String {
        val start = source.indexOf(of)
        assertTrue("$of not found", start >= 0)
        return source.substring(start, source.indexOf(until, start))
    }

    @Test
    fun updateSkipsWithoutAServiceAndCatchesTheRefusal() {
        val b = body("fun updateStatus(", "fun stop(")
        assertTrue(b.contains("if (!isRunning)"))
        assertTrue(b.contains("try {") && b.contains("catch (e: Exception)"))
    }

    @Test
    fun stopCatchesTheRefusal() {
        val b = body("fun stop(context: Context, callId: String? = null)", "fun isStartStale")
        assertTrue(b.contains("try {") && b.contains("catch (e: Exception)"))
    }

    @Test
    fun staleUpdateStopsTheInstanceItCreated() {
        val b = body("ACTION_UPDATE -> {", "val status = intent.getStringExtra(EXTRA_STATUS)")
        assertTrue(b.contains("stopSelf(startId)"))
    }
}
