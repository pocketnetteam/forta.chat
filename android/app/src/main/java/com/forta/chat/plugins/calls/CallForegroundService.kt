package com.forta.chat.plugins.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.forta.chat.R
import com.forta.chat.plugins.locale.LocaleHelper
import com.forta.chat.plugins.webrtc.WebRTCPlugin

/**
 * Foreground service that keeps the call alive when the app is backgrounded.
 *
 * Responsibilities:
 * - Persistent notification showing call status (required for foreground service)
 * - Audio focus management (pause other apps' audio during call)
 * - Wakelock to prevent CPU sleep during active call
 * - Lifecycle tied to call duration
 */
class CallForegroundService : Service() {

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocaleHelper.wrapContext(newBase))
    }

    companion object {
        private const val TAG = "CallForegroundService"
        private const val CHANNEL_ID = "active_call"
        private const val NOTIFICATION_ID = 10001
        private const val WAKELOCK_TAG = "bastyon:call_wakelock"

        const val ACTION_START = "com.forta.chat.CALL_START"
        const val ACTION_STOP = "com.forta.chat.CALL_STOP"
        const val ACTION_UPDATE = "com.forta.chat.CALL_UPDATE"
        const val ACTION_HANGUP = "com.forta.chat.CALL_HANGUP"

        const val EXTRA_CALLER_NAME = "callerName"
        const val EXTRA_CALL_TYPE = "callType"
        const val EXTRA_STATUS = "status"
        const val EXTRA_DURATION = "duration"

        fun start(context: Context, callerName: String, callType: String) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_CALLER_NAME, callerName)
                putExtra(EXTRA_CALL_TYPE, callType)
            }
            try {
                context.startForegroundService(intent)
            } catch (e: Throwable) {
                // WEE-31: Android 12+ ForegroundServiceStartNotAllowedException
                // when the call accept path is invoked from a context the OS
                // doesn't consider eligible to start an FGS (e.g. an OEM
                // killed the app between the FCM push and the user tap).
                // Logging-only — caller's accept flow will surface the audio
                // error through AudioRouter and the user can retry. Without
                // this, the throw would crash the callee process.
                Log.e(TAG, "[callee-crash-guard] startForegroundService rejected", e)
            }
        }

        fun updateStatus(context: Context, status: String, duration: String = "") {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_STATUS, status)
                putExtra(EXTRA_DURATION, duration)
            }
            context.startService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, CallForegroundService::class.java).apply {
                action = ACTION_STOP
            }
            context.startService(intent)
        }

        // D-10: Re-request audio focus from CallActivity.onResume.
        // Session 54: @Volatile so the isRunning getter can be read safely
        // from non-main threads if a future caller does so. Today all
        // readers are on the main thread (watchdog + CallActivity.onResume),
        // but the cost of @Volatile is a single memory barrier so the
        // safety win is free.
        @Volatile
        private var instance: CallForegroundService? = null

        /**
         * Session 54: exposed read-only liveness flag. Other call surfaces
         * (AudioRouter orphan watchdog, CallActivity.onResume) need to know
         * whether the foreground service is actually running before
         * restoring MODE_IN_COMMUNICATION — assuming the service is up just
         * because we have a saved Activity reference is what produced the
         * orphan VoIP-mode bug (#708 / #462). Kept as a property getter so
         * the underlying `instance` reference can stay private.
         */
        @JvmStatic
        val isRunning: Boolean
            get() = instance != null

        fun reRequestAudioFocus(context: Context) {
            instance?.requestAudioFocus()
                ?: Log.w("WebRTCAudio", "reRequestAudioFocus: service not running")
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var savedVoiceCallVolume: Int = -1
    // WEE-45: NotificationCompat.CallStyle.forOngoingCall throws
    // IllegalArgumentException when the Person it wraps has an empty
    // name. On a second call right after the first one stopped, the
    // OS sometimes delivers ACTION_UPDATE to a freshly-recreated service
    // instance BEFORE ACTION_START runs (lifecycle race observed on
    // Samsung One UI / Z Flip 4), at which point `callerName` is still
    // the empty default. Initialising to a non-empty fallback keeps the
    // notification builder safe even if updateNotification is ever
    // invoked before the real caller name is known. The fallback is the
    // app's display label so the notification still reads sensibly.
    private var callerName = "Forta Chat"
    private var callType = ""
    // Tracks whether ACTION_START actually populated callerName/callType
    // for this service instance. Lets ACTION_UPDATE detect the
    // out-of-order delivery path and ignore the update instead of
    // rendering a placeholder Person — the next legitimate START will
    // build the notification correctly with the real caller name.
    private var hasStarted: Boolean = false

    private val binder = LocalBinder()

    inner class LocalBinder : Binder() {
        fun getService(): CallForegroundService = this@CallForegroundService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        instance = this
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                // Coalesce blank/missing values to non-empty defaults — the
                // Android NotificationCompat.CallStyle person-name guard is
                // strict and rejects empty strings (not just nulls).
                val incomingName = intent.getStringExtra(EXTRA_CALLER_NAME)
                callerName = if (incomingName.isNullOrBlank()) "Unknown" else incomingName
                callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
                hasStarted = true
                startForegroundWithNotification(getString(R.string.call_connecting))
                acquireWakeLock()
                requestAudioFocus()
                Log.d(TAG, "Service started for call with $callerName")
            }
            ACTION_UPDATE -> {
                // WEE-45: ignore ACTION_UPDATE that arrives before ACTION_START
                // populated this instance. On Samsung One UI the OS occasionally
                // delivers a stale UPDATE intent to a freshly-recreated service
                // process (second call right after the first stopped); without
                // this guard, buildNotification would call
                // CallStyle.forOngoingCall with the fallback caller name and
                // dump a misleading notification, or — pre-WEE-45 — crash with
                // `person must have a non-empty a name` when callerName was "".
                if (!hasStarted) {
                    Log.w(TAG, "ACTION_UPDATE before ACTION_START — ignoring stale update")
                    return START_NOT_STICKY
                }
                val status = intent.getStringExtra(EXTRA_STATUS) ?: ""
                val duration = intent.getStringExtra(EXTRA_DURATION) ?: ""
                val text = if (duration.isNotEmpty()) "$status - $duration" else status
                updateNotification(text)
            }
            ACTION_HANGUP -> {
                // Hangup triggered from notification action
                CallActivity.onCallEnded?.invoke()
                stopSelf()
            }
            ACTION_STOP -> {
                hasStarted = false
                releaseWakeLock()
                abandonAudioFocus()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                Log.d(TAG, "Service stopped")
            }
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // WEE-54 / forta-bugs#839 (reopen): when the user swipes the app out of
        // Recents during or right after a call, Android delivers onTaskRemoved
        // but does NOT always call onDestroy promptly — the OS can keep the
        // service record around (especially on OEM ROMs), so AudioRouter stays
        // in MODE_IN_COMMUNICATION and the cellular network is blocked until
        // reboot. WEE-49 only hardened onDestroy(); this swipe-out path slipped
        // through, which is why #839 reopened on 1.10.31. Mirror the onDestroy
        // brute-force cleanup here and stopSelf() so teardown is deterministic.
        runCatching {
            AudioRouter.getSharedInstance(applicationContext).forceStop()
        }.onFailure { Log.w(TAG, "AudioRouter.forceStop in onTaskRemoved threw", it) }

        runCatching {
            stopForeground(STOP_FOREGROUND_REMOVE)
        }.onFailure { Log.w(TAG, "stopForeground in onTaskRemoved threw", it) }

        hasStarted = false
        releaseWakeLock()
        abandonAudioFocus()
        // Clear liveness NOW, not in the (possibly deferred) onDestroy. The
        // audio mode has already been torn down above, but `isRunning` is what
        // the AudioRouter orphan watchdog and CallActivity.onResume consult
        // before restoring MODE_IN_COMMUNICATION. If we left `instance`
        // non-null until the OS finally runs onDestroy, a surface waking in
        // that window would see a "running" call and re-apply comm mode —
        // re-stranding the audio and re-creating the orphan VoIP-mode bug
        // (#708 / #462) that this whole cellular-unblock fix targets. Nulling
        // here keeps liveness consistent with the teardown that just ran;
        // onDestroy setting it null again is an idempotent no-op.
        instance = null

        super.onTaskRemoved(rootIntent)
        // stopSelf so the OS finalises the service (and runs onDestroy) instead
        // of leaving a zombie service record holding the audio mode.
        stopSelf()
    }

    override fun onDestroy() {
        // WEE-49: when the OS tears the service down without going through
        // ACTION_STOP (process killed by OEM Doze, swipe-app-out, low-mem
        // SIGKILL, system-initiated `stopWithReason`), the previous teardown
        // only released the wake-lock + abandoned audio focus. AudioRouter
        // stayed in MODE_IN_COMMUNICATION, holding the voice-call audio
        // mode globally and blocking cellular network until reboot
        // (#839 post-WEE-45 residual, #771 phantom call). Brute-force reset
        // the router and pull the notification surface explicitly so the
        // OS recognises the call as fully ended.
        runCatching {
            AudioRouter.getSharedInstance(applicationContext).forceStop()
        }.onFailure { Log.w(TAG, "AudioRouter.forceStop in onDestroy threw", it) }

        runCatching {
            stopForeground(STOP_FOREGROUND_REMOVE)
        }.onFailure { Log.w(TAG, "stopForeground in onDestroy threw", it) }

        hasStarted = false
        releaseWakeLock()
        abandonAudioFocus()
        instance = null
        super.onDestroy()
    }

    // -----------------------------------------------------------------------
    // Notification
    // -----------------------------------------------------------------------

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_active_call),
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = getString(R.string.channel_active_call_desc)
            setSound(null, null)
            enableVibration(false)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification(status: String) {
        val notification = buildNotification(status)
        // Android 14+ (API 34) requires the foreground-service type bitmask
        // at startForeground time. Without it the platform throws
        // ForegroundServiceTypeException and the process crashes immediately
        // when the user accepts a call (#640, #623, #624).
        // We declare both microphone and phoneCall so the OS recognises the
        // service as a real call surface AND a legitimate audio capturer —
        // either flag alone is rejected on Pixel 6 Pro / Samsung A05 / etc.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
                )
                return
            } catch (e: SecurityException) {
                // RECORD_AUDIO permission revoked between accept and FGS
                // start — fall back to the call-only type so the notification
                // still appears and the user can hang up. AudioRouter will
                // surface the missing-mic error through the JS bridge.
                Log.e(TAG, "FGS_TYPE_MICROPHONE rejected, falling back to phoneCall-only", e)
                try {
                    startForeground(
                        NOTIFICATION_ID,
                        notification,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
                    )
                    return
                } catch (e2: Throwable) {
                    // WEE-31: even phoneCall-only can be rejected on some
                    // OEM builds (HarmonyOS) or when the OS thinks the
                    // service was started from a disallowed background
                    // context. Fall through to the untyped path below.
                    Log.e(TAG, "[callee-crash-guard] phoneCall-only startForeground rejected", e2)
                }
            } catch (e: Throwable) {
                // WEE-31 (H2): Android 12+ ForegroundServiceStartNotAllowedException
                // when startForegroundService → startForeground timing slips
                // past the 5s background-start window (FCM-triggered path
                // is most exposed). InvalidForegroundServiceTypeException on
                // a few Xiaomi / HarmonyOS builds. Either of these used to
                // process-kill the callee "наглухо".
                Log.e(TAG, "[callee-crash-guard] typed startForeground threw, retrying untyped", e)
            }
        }
        // Untyped fallback path (pre-Android-14, or post-Android-14 after
        // a typed startForeground failure). Still wrapped so an exotic
        // OEM that disallows even this can't kill the process.
        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (e: Throwable) {
            Log.e(TAG, "[callee-crash-guard] untyped startForeground also failed; service will run without FGS", e)
            // Best-effort: post the notification through the manager so the
            // user still sees the ongoing call surface (no FGS lifetime
            // guarantees but the call thread is alive). stopSelf if even
            // that fails — never let the service-start path crash the
            // process.
            runCatching {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, notification)
            }
        }
    }

    private fun updateNotification(status: String) {
        val notification = buildNotification(status)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(status: String): Notification {
        val contentIntent = Intent(this, CallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val contentPendingIntent = PendingIntent.getActivity(
            this, 0, contentIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val hangupIntent = Intent(this, CallForegroundService::class.java).apply {
            action = ACTION_HANGUP
        }
        val hangupPendingIntent = PendingIntent.getService(
            this, 1, hangupIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val typeLabel = if (callType == "video") getString(R.string.call_video_call) else getString(R.string.call_voice_call)

        // WEE-45: NotificationCompat.CallStyle throws on empty Person names.
        // The instance fallback above should keep callerName non-empty, but
        // a final guard here ensures any future code path that mutates
        // callerName cannot crash the foreground service. The fallback is
        // a sensible app label — never user-controlled, never blank.
        val safeCallerName = if (callerName.isBlank()) "Forta Chat" else callerName
        val caller = androidx.core.app.Person.Builder()
            .setName(safeCallerName)
            .setImportant(true)
            .build()

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(contentPendingIntent)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
            builder.setStyle(
                NotificationCompat.CallStyle.forOngoingCall(caller, hangupPendingIntent)
            )
            builder.setContentText(status)
        } else {
            builder.setContentTitle(if (callType == "video") getString(R.string.call_video_call_with, safeCallerName) else getString(R.string.call_voice_call_with, safeCallerName))
            builder.setContentText(status)
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                getString(R.string.call_hang_up),
                hangupPendingIntent
            )
        }

        return builder.build()
    }

    // -----------------------------------------------------------------------
    // Audio Focus
    // -----------------------------------------------------------------------

    // D-09: Full audio focus change listener with duck/mute/restore
    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        when (focusChange) {
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // D-09: Lower volume to ~30%
                Log.d("WebRTCAudio", "Focus: DUCK — lowering volume")
                audioManager?.let { am ->
                    val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                    am.setStreamVolume(
                        AudioManager.STREAM_VOICE_CALL,
                        (maxVol * 0.3).toInt().coerceAtLeast(1),
                        0
                    )
                }
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // D-09: Mute local mic
                Log.d("WebRTCAudio", "Focus: TRANSIENT_LOSS — muting mic")
                WebRTCPlugin.manager?.setAudioEnabled(false)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                // D-09: Restore volume + unmute
                Log.d("WebRTCAudio", "Focus: GAIN — restoring audio")
                if (savedVoiceCallVolume >= 0) {
                    audioManager?.setStreamVolume(
                        AudioManager.STREAM_VOICE_CALL,
                        savedVoiceCallVolume,
                        0
                    )
                }
                WebRTCPlugin.manager?.setAudioEnabled(true)
            }
            AudioManager.AUDIOFOCUS_LOSS -> {
                // D-09: Permanent loss — log warning, don't drop the call
                Log.w("WebRTCAudio", "Focus: PERMANENT_LOSS — warning only, call continues")
            }
            else -> {
                Log.d("WebRTCAudio", "Focus: unknown change=$focusChange")
            }
        }
    }

    private fun requestAudioFocus() {
        val am = audioManager ?: return

        // Save current volume for restore (D-09)
        savedVoiceCallVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)

        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        // Use AUDIOFOCUS_GAIN (not TRANSIENT) — Chinese OEM firmwares (MIUI,
        // RealmeUI, XOS) may return audio focus prematurely with transient mode,
        // causing zero-way audio. Full gain properly displaces media players.
        audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attrs)
            .setAcceptsDelayedFocusGain(true)
            .setOnAudioFocusChangeListener(audioFocusChangeListener)
            .build()

        val result = am.requestAudioFocus(audioFocusRequest!!)
        Log.d("WebRTCAudio", "Audio focus requested (GAIN), result=$result")
    }

    private fun abandonAudioFocus() {
        audioFocusRequest?.let {
            audioManager?.abandonAudioFocusRequest(it)
            audioFocusRequest = null
        }
        // Session 23 / D-09: restore the user's previous voice-call
        // volume here, in addition to the existing AUDIOFOCUS_GAIN
        // listener path. When we self-abandon the focus (call ended
        // normally) the focus change listener does not fire — without
        // this explicit restore the voice-call volume could stay at
        // the ducked level set by an earlier focus change.
        if (savedVoiceCallVolume >= 0) {
            try {
                audioManager?.setStreamVolume(
                    AudioManager.STREAM_VOICE_CALL,
                    savedVoiceCallVolume,
                    0,
                )
            } catch (e: Exception) {
                Log.w("WebRTCAudio", "Failed to restore voice call volume", e)
            }
            savedVoiceCallVolume = -1
        }
    }

    // -----------------------------------------------------------------------
    // Wakelock
    // -----------------------------------------------------------------------

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG).apply {
            acquire(60 * 60 * 1000L) // 1 hour max
        }
        Log.d(TAG, "Wakelock acquired")
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
            wakeLock = null
        }
    }
}
