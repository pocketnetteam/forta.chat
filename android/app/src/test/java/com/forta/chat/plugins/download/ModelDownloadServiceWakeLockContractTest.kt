package com.forta.chat.plugins.download

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression for background model downloads stalling once the screen locks.
 *
 * `ModelDownloadService` runs as a foreground service (so the process itself
 * survives being backgrounded), but a foreground service alone does not stop
 * the CPU from suspending once the screen turns off — without a wakelock a
 * multi-GB download can sit stalled until the user taps the device again,
 * same class of problem `CallForegroundService` already solves for calls
 * with a `PARTIAL_WAKE_LOCK`.
 *
 * Robolectric-free source-level assertion, same pattern as
 * `CallForegroundServiceDestroyContractTest` — exercising the real Service
 * lifecycle would need a fake PowerManager/Service host, far more brittle
 * than the acquire/release contract this regression actually cares about.
 */
class ModelDownloadServiceWakeLockContractTest {

    private val source: String by lazy {
        val candidates = listOf(
            "src/main/java/com/forta/chat/plugins/download/ModelDownloadService.kt",
            "android/app/src/main/java/com/forta/chat/plugins/download/ModelDownloadService.kt",
        )
        val resolved = candidates.map { File(it) }.firstOrNull { it.exists() }
            ?: error(
                "ModelDownloadService.kt not found. Tried: $candidates from ${File(".").absolutePath}",
            )
        resolved.readText()
    }

    @Test
    fun actionStart_acquiresWakeLock_beforeTheDownloadThreadRuns() {
        val block = extractWhenBranch("ACTION_START")
        assertTrue(
            "ACTION_START must call acquireWakeLock() so the CPU cannot suspend " +
                "mid-download once the screen locks:\n$block",
            block.contains("acquireWakeLock()"),
        )
    }

    @Test
    fun actionPause_releasesWakeLock() {
        val block = extractWhenBranch("ACTION_PAUSE")
        assertTrue(
            "ACTION_PAUSE must call releaseWakeLock() — a paused download has " +
                "nothing left to keep the CPU awake for:\n$block",
            block.contains("releaseWakeLock()"),
        )
    }

    @Test
    fun actionStop_releasesWakeLock() {
        val block = extractWhenBranch("ACTION_STOP")
        assertTrue(
            "ACTION_STOP must call releaseWakeLock():\n$block",
            block.contains("releaseWakeLock()"),
        )
    }

    @Test
    fun onDestroy_releasesWakeLock_soAnOsKilledServiceCannotLeakIt() {
        val block = extractFunctionBody("onDestroy")
        assertTrue(
            "onDestroy() must call releaseWakeLock() so a service killed " +
                "without going through ACTION_PAUSE/ACTION_STOP (OEM Doze, " +
                "swipe-app-out, low-memory SIGKILL) cannot leak a held wakelock:\n$block",
            block.contains("releaseWakeLock()"),
        )
    }

    @Test
    fun runDownload_releasesWakeLock_onNaturalCompletionOrFailure() {
        val block = extractFunctionBody("runDownload")
        assertTrue(
            "runDownload()'s teardown path must call releaseWakeLock() so a " +
                "completed or failed download doesn't hold the CPU awake " +
                "indefinitely:\n$block",
            block.contains("releaseWakeLock()"),
        )
    }

    @Test
    fun wakeLock_isPartialOnly_neverKeepsTheScreenOn() {
        val block = extractFunctionBody("acquireWakeLock")
        assertTrue(
            "acquireWakeLock() must request PARTIAL_WAKE_LOCK (CPU only) — " +
                "the download must not force the screen to stay on:\n$block",
            block.contains("PowerManager.PARTIAL_WAKE_LOCK"),
        )
        assertFalse(
            "acquireWakeLock() must not request a screen-dim/bright wakelock:\n$block",
            block.contains("SCREEN_DIM_WAKE_LOCK") || block.contains("SCREEN_BRIGHT_WAKE_LOCK"),
        )
    }

    @Test
    fun releaseWakeLock_checksIsHeld_beforeReleasing() {
        val block = extractFunctionBody("releaseWakeLock")
        assertTrue(
            "releaseWakeLock() must check isHeld before release() — releasing " +
                "an already-released lock throws IllegalStateException on some " +
                "OEM builds:\n$block",
            block.contains("isHeld"),
        )
    }

    /**
     * Extract the body of a top-level `private fun <name>(...)` or
     * `override fun <name>(...)` block. Brace-counts so nested blocks
     * (if/try/apply/let) do not end the match early.
     */
    private fun extractFunctionBody(name: String): String {
        val signature = Regex("(?:override|private)\\s+fun\\s+$name\\s*\\([^)]*\\)[^{]*\\{")
        val match = signature.find(source)
            ?: error("Could not find fun $name in source")
        return extractBraceBlock(match.range.last + 1)
    }

    /** Extract one `<LABEL> -> { ... }` branch out of `onStartCommand`'s `when`. */
    private fun extractWhenBranch(label: String): String {
        val signature = Regex("$label\\s*->\\s*\\{")
        val match = signature.find(source)
            ?: error("Could not find $label branch in source")
        return extractBraceBlock(match.range.last + 1)
    }

    private fun extractBraceBlock(startIndex: Int): String {
        var depth = 1
        var i = startIndex
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
