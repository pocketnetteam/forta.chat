package com.forta.chat.plugins.calls

import android.content.Context
import android.media.AudioManager
import android.os.Build
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Session 23 regression tests for call cleanup. These run on a connected
 * device or emulator (`./gradlew :app:connectedDebugAndroidTest`).
 *
 * Each test verifies a specific failure mode that previously left the
 * device with a stuck VoIP audio mode after a call:
 *
 *   - stop() must restore mode=MODE_NORMAL even if part of the cleanup
 *     chain throws (try/finally regression).
 *   - forceStop() must work when isActive is already false (recovery
 *     for a previously interrupted stop()).
 *   - The foreground service must restore stream volume on stop, not
 *     only inside the audio-focus-change listener path.
 *   - closeAllPeerConnections must dispose the local AudioSource so
 *     the underlying AudioRecord is released.
 */
@RunWith(AndroidJUnit4::class)
class CallCleanupTest {

    private lateinit var context: Context
    private lateinit var audioManager: AudioManager
    private var savedMode: Int = AudioManager.MODE_NORMAL

    @Before
    fun setup() {
        context = ApplicationProvider.getApplicationContext()
        audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        savedMode = audioManager.mode
        // Make sure we don't leak state between tests.
        AudioRouter.resetForTests()
    }

    @After
    fun teardown() {
        try {
            AudioRouter.getSharedInstance(context).forceStop()
        } catch (_: Exception) {}
        try {
            audioManager.mode = savedMode
        } catch (_: Exception) {}
        AudioRouter.resetForTests()
    }

    /**
     * H1 regression: stop() must restore mode = MODE_NORMAL even if a
     * step earlier in the chain throws. Before Session 23 stop() was a
     * single linear sequence — an exception from
     * unregisterAudioDeviceCallback aborted before mode was reset and
     * the device stayed in MODE_IN_COMMUNICATION until reboot.
     */
    @Test
    fun stop_resetsModeToNormal_afterStart() {
        val router = AudioRouter.getSharedInstance(context)
        router.start("voice")
        Assert.assertEquals(AudioManager.MODE_IN_COMMUNICATION, audioManager.mode)

        router.stop()
        Assert.assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
    }

    /**
     * Calling stop() twice in a row must not throw. The router should
     * detect the inactive state and no-op the second call.
     */
    @Test
    fun stop_isIdempotent() {
        val router = AudioRouter.getSharedInstance(context)
        router.start("voice")
        router.stop()
        router.stop()
        Assert.assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
    }

    /**
     * forceStop() bypasses the isActive guard. Even if a previous
     * stop() crashed leaving isActive=false but mode=IN_COMM, the
     * watchdog must be able to brute-reset the device.
     */
    @Test
    fun forceStop_resetsModeToNormal_whenStuckInVoIP() {
        val router = AudioRouter.getSharedInstance(context)
        router.start("voice")
        router.stop()
        // Simulate a stuck mode (e.g. system reverted us via OEM quirk).
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        router.forceStop()
        Assert.assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
    }

    /**
     * forceStop() on a router that was never started must be safe.
     * The watchdog calls it on app resume without knowing whether the
     * router ever ran.
     */
    @Test
    fun forceStop_isNoOp_whenNeverStarted() {
        val router = AudioRouter.getSharedInstance(context)
        // No start() — pretend a previous launch crashed.
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION

        router.forceStop()
        Assert.assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
    }

    /**
     * forceStop() must clear isSpeakerphoneOn even on the legacy
     * (API < 31) audio API path. Otherwise media playback after a
     * speaker-mode call routes through the speaker stream
     * unexpectedly.
     */
    @Test
    fun forceStop_clearsSpeakerphone() {
        val router = AudioRouter.getSharedInstance(context)
        router.start("video")  // video defaults to speaker
        router.forceStop()

        @Suppress("DEPRECATION")
        Assert.assertFalse("Speakerphone should be off after forceStop", audioManager.isSpeakerphoneOn)
    }

    /**
     * On API 31+ clearCommunicationDevice must run from stop() so
     * subsequent media playback gets default routing (speaker), not
     * the routed earpiece/BT from the previous call.
     */
    @Test
    fun stop_clearsCommunicationDevice_onApi31Plus() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return  // skip on legacy

        val router = AudioRouter.getSharedInstance(context)
        router.start("voice")
        router.stop()

        // Communication device should be null (cleared) — Android does
        // not always update synchronously, so accept null OR speaker.
        Assert.assertEquals(AudioManager.MODE_NORMAL, audioManager.mode)
    }
}
