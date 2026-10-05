package com.forta.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Regression: minSdk is 24 (Android 7.0), but the call service, the ringer,
 * the notification cleanup, Tor and the model/AI services called API 26/28
 * methods unguarded (43 lint NewApi errors). On Android 7.x the call service
 * threw from onCreate (NotificationChannel) and killed the process at every
 * call, the ringer threw before play() (Ringtone.setLooping, API 28) and rang
 * silently. Lint is not run in CI, so the riskiest sites are pinned here; run
 * `./gradlew :app:lintSideloadDebug` for the full NewApi check.
 */
class Android7ApiGuardContractTest {

    private val root = listOf("src/main/java/com/forta/chat", "android/app/src/main/java/com/forta/chat")
        .map { File(it) }.first { it.exists() }

    private fun read(path: String) = File(root, path).readText()

    @Test
    fun noRawStartForegroundService() {
        root.walkTopDown().filter { it.extension == "kt" }.forEach { f ->
            assertFalse(
                "${f.name} calls Context.startForegroundService directly (API 26)",
                Regex("""(?<!ContextCompat\.)\bcontext\.startForegroundService\(""").containsMatchIn(f.readText()),
            )
        }
    }

    @Test
    fun notificationChannelsAreCreatedOnlyOnAndroid8() {
        for (path in listOf(
            "plugins/calls/CallForegroundService.kt",
            "plugins/aiinference/AiInferenceForegroundService.kt",
            "plugins/download/ModelDownloadService.kt",
        )) {
            val s = read(path)
            val start = s.indexOf("private fun createNotificationChannel()")
            val body = s.substring(start, s.indexOf("val channel = NotificationChannel(", start))
            assertTrue("$path: channel creation without an SDK guard", body.contains("Build.VERSION_CODES.O"))
        }
        val telecom = read("plugins/calls/CallConnectionService.kt")
        val at = telecom.indexOf("val channel = NotificationChannel(")
        assertTrue(telecom.substring(at - 200, at).contains("Build.VERSION.SDK_INT >= Build.VERSION_CODES.O"))
    }

    @Test
    fun ringerLoopsAndVibratesBelowItsApiLevels() {
        val s = read("plugins/calls/IncomingRinger.kt")
        assertTrue(s.contains("if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true"))
        assertTrue(s.contains("vibrator?.vibrate(pattern, 0)"))
    }

    @Test
    fun audioFocusHasALegacyPath() {
        val s = read("plugins/calls/CallForegroundService.kt")
        assertTrue(s.contains("AudioManager.STREAM_VOICE_CALL,\n                AudioManager.AUDIOFOCUS_GAIN"))
        assertTrue(s.contains("abandonAudioFocus(audioFocusChangeListener)"))
    }

    @Test
    fun torAndNotificationCleanupAvoidApi26Getters() {
        assertTrue(read("plugins/tor/ProcessRunner.kt").contains("IllegalThreadStateException"))
        val push = read("plugins/push/PushDataPlugin.kt")
        assertFalse(push.contains("sb.notification?.channelId"))
        assertTrue(push.contains("private fun isMessagesChannel"))
    }
}
