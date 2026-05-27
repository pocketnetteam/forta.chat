package com.forta.chat.plugins.calls

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * WEE-49: regression for post-call audio mode leak / cellular block (#839, #771).
 *
 * The original `onDestroy()` only released the wake-lock and abandoned audio
 * focus. When Android killed the service without going through `ACTION_STOP`
 * (OEM Doze / battery-saver / swipe-app-out / low-memory SIGKILL), the
 * AudioRouter stayed in `MODE_IN_COMMUNICATION` forever and the device's
 * cellular network was effectively blocked until reboot.
 *
 * Robolectric-free source-level assertion in the same spirit as
 * [AudioRouterModeReapplyTest] — exercising the real lifecycle would require
 * spinning up a Service host and a fake AudioManager, which is far more
 * brittle than the cleanup contract this regression cares about.
 */
class CallForegroundServiceDestroyContractTest {

    private val source: String by lazy {
        val candidates = listOf(
            "src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
            "android/app/src/main/java/com/forta/chat/plugins/calls/CallForegroundService.kt",
        )
        val resolved = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error(
                "CallForegroundService.kt not found. Tried: $candidates from ${File(".").absolutePath}",
            )
        resolved.readText()
    }

    @Test
    fun onDestroy_forceStopsAudioRouter_toRestoreAudioMode() {
        // forceStop() bypasses AudioRouter's `isActive` guard and brute-
        // force restores MODE_NORMAL — the only safe call from a destroy
        // path because the JS-side stopAudioRouting may never have fired.
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must call AudioRouter.forceStop() to recover from " +
                "OEM-killed service paths (WEE-49 / forta-bugs#839):\n$onDestroyBlock",
            onDestroyBlock.contains("AudioRouter.getSharedInstance(") &&
                onDestroyBlock.contains(".forceStop()"),
        )
    }

    @Test
    fun onDestroy_explicitlyStopsForeground_soNotificationDoesNotLinger() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must call stopForeground(STOP_FOREGROUND_REMOVE) so " +
                "the call notification disappears when the OS kills the service " +
                "without ACTION_STOP:\n$onDestroyBlock",
            onDestroyBlock.contains("stopForeground(STOP_FOREGROUND_REMOVE)"),
        )
    }

    @Test
    fun onDestroy_wrapsBruteResetInRunCatching_soOneFailureDoesNotSwallowTheNext() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        // Both brute-force calls must be wrapped — if forceStop throws and
        // stopForeground is not wrapped, the notification would leak forever.
        val runCatchingHits = Regex("runCatching\\s*\\{")
            .findAll(onDestroyBlock).count()
        assertTrue(
            "onDestroy() must wrap at least two brute-force steps in runCatching " +
                "(found $runCatchingHits):\n$onDestroyBlock",
            runCatchingHits >= 2,
        )
    }

    @Test
    fun onDestroy_clearsHasStartedFlag_soStaleUpdatesAreRejectedAfterRebirth() {
        val onDestroyBlock = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must reset hasStarted=false so a future ACTION_UPDATE " +
                "arriving before the next ACTION_START is ignored " +
                "(WEE-45 protection survives a destroy/recreate cycle):\n$onDestroyBlock",
            onDestroyBlock.contains("hasStarted = false"),
        )
    }

    /**
     * Extract the body of a top-level `override fun <name>(...)` block from the
     * Kotlin source. Brace-counts so nested blocks (if/try/runCatching) do not
     * end the match early.
     */
    private fun extractFunctionBody(name: String): String {
        val signature = Regex("override\\s+fun\\s+$name\\s*\\([^)]*\\)\\s*\\{")
        val match = signature.find(source)
            ?: error("Could not find override fun $name in source")
        var depth = 1
        var i = match.range.last + 1
        val start = i
        while (i < source.length && depth > 0) {
            when (source[i]) {
                '{' -> depth++
                '}' -> depth--
            }
            i++
        }
        return source.substring(start, i - 1)
    }
}

