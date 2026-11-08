package com.forta.chat.plugins.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log

/**
 * The one owner of the incoming-call ringtone, vibration and the 30-second
 * no-answer deadline, keyed by callId — see [IncomingRingerLedger] for why it
 * is not the activity.
 *
 * Every answer route stops it: the activity's Accept button, Telecom's
 * `onAnswer` (headset, Android Auto, the system call UI), the JS-side
 * `reportCallConnected`, and [CallTeardown] for a call that ended. A stop
 * keyed to another call is a no-op, so the second incoming call that
 * displaced the first cannot be silenced by the first one's teardown.
 */
object IncomingRinger {
    private const val TAG = "IncomingRinger"
    const val AUTO_REJECT_TIMEOUT_MS = 30_000L
    private const val LEGACY_LOOP_CHECK_MS = 1_000L

    private val ledger = IncomingRingerLedger()
    private val handler = Handler(Looper.getMainLooper())
    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null

    /** The call this process rings for right now, or null. */
    val ringingCallId: String?
        get() = ledger.armedCallId

    /**
     * Ring for [callId]; a previous ring is replaced. [onTimeout] runs on
     * the main thread after [AUTO_REJECT_TIMEOUT_MS] unless [stop] or another
     * [arm] intervened — an answered call never sees the auto-reject.
     */
    fun arm(context: Context, callId: String, onTimeout: () -> Unit) {
        val app = context.applicationContext
        val token = synchronized(this) {
            stopHardware()
            val t = ledger.arm(callId)
            // A second ringer instance for a call the user already silenced
            // keeps it quiet; the deadline restarts either way.
            if (!ledger.isSilenced(callId)) {
                runCatching { startRingtone(app) }.onFailure { Log.w(TAG, "ringtone failed", it) }
                runCatching { startVibration(app) }.onFailure { Log.w(TAG, "vibration failed", it) }
            }
            t
        }
        handler.postDelayed({
            if (!ledger.mayFire(token)) return@postDelayed
            Log.w(TAG, "no answer in ${AUTO_REJECT_TIMEOUT_MS / 1000}s for $callId — auto-rejecting")
            // Nothing catches a throw out of a main-looper Runnable.
            runCatching(onTimeout).onFailure { Log.e(TAG, "auto-reject threw", it) }
        }, AUTO_REJECT_TIMEOUT_MS)
        Log.d(TAG, "arm callId=$callId")
    }

    /** Stop the ring for [callId]; returns whether it was ringing for that call. */
    fun stop(callId: String?): Boolean = synchronized(this) {
        val wasRinging = ledger.stop(callId)
        if (wasRinging) {
            stopHardware()
            Log.d(TAG, "stop callId=$callId")
        }
        wasRinging
    }

    /**
     * Stop the ringtone and the vibration of whatever rings, and nothing else:
     * the ringer screen stays up and the 30 s deadline still runs. Telecom asks
     * for this when the user presses a volume key while the call rings.
     * Returns whether anything was ringing.
     */
    fun silence(): Boolean {
        synchronized(this) {
            val callId = ledger.silence() ?: return false
            stopHardware()
            Log.d(TAG, "silence callId=$callId (deadline kept)")
        }
        return true
    }

    /** Stop whatever rings: the call was answered or connected, whichever id it carried. */
    fun stopAll(): Boolean = stop(null)

    fun isRingingFor(callId: String): Boolean = ledger.isArmedFor(callId)

    private fun stopHardware() {
        handler.removeCallbacks(legacyLoop)
        runCatching { ringtone?.stop() }
        ringtone = null
        runCatching { vibrator?.cancel() }
        vibrator = null
    }

    private fun startRingtone(app: Context) {
        ensureRingerAudible(app)
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        ringtone = RingtoneManager.getRingtone(app, uri)?.apply {
            audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
            // Ringtone.setLooping is Android 9+; below it the call threw before
            // play() and the phone rang silently. Replay it instead.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) isLooping = true
            play()
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) handler.postDelayed(legacyLoop, LEGACY_LOOP_CHECK_MS)
    }

    /** Android 7–8 loop: replay the ringtone while it is still the one ringing. */
    private val legacyLoop: Runnable = object : Runnable {
        override fun run() {
            // Under the lock: stop() runs on the plugin thread too, and a replay
            // that slipped in after it would ring on for a call already over.
            synchronized(this@IncomingRinger) {
                val current = ringtone ?: return
                runCatching { if (!current.isPlaying) current.play() }
                handler.postDelayed(this, LEGACY_LOOP_CHECK_MS)
            }
        }
    }

    private fun startVibration(app: Context) {
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        val pattern = longArrayOf(0, 1000, 1000)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
        }
    }

    /**
     * WEE-54 / forta-bugs#862: bump STREAM_RING when an OEM (MIUI / HyperOS)
     * has left it muted while the phone is in normal ringer mode, otherwise
     * the system ringtone plays inaudibly and only the vibration is felt.
     * Silent / vibrate ringer modes are respected (no-op) — see
     * [CallNotificationConfig.ringVolumeToForce]. Best-effort: any failure
     * (locked stream on hardened ROMs) is swallowed; vibration still fires.
     */
    private fun ensureRingerAudible(app: Context) {
        try {
            val am = app.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
            val target = CallNotificationConfig.ringVolumeToForce(
                ringerMode = am.ringerMode,
                currentVolume = am.getStreamVolume(AudioManager.STREAM_RING),
                maxVolume = am.getStreamMaxVolume(AudioManager.STREAM_RING),
            ) ?: return
            am.setStreamVolume(AudioManager.STREAM_RING, target, 0)
        } catch (e: Exception) {
            Log.w(TAG, "ensureRingerAudible failed", e)
        }
    }
}
