package com.forta.chat.plugins.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Binder
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
            context.startForegroundService(intent)
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

        // D-10: Re-request audio focus from CallActivity.onResume
        private var instance: CallForegroundService? = null

        fun reRequestAudioFocus(context: Context) {
            instance?.requestAudioFocus()
                ?: Log.w("WebRTCAudio", "reRequestAudioFocus: service not running")
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var savedVoiceCallVolume: Int = -1
    private var callerName = ""
    private var callType = ""

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
                callerName = intent.getStringExtra(EXTRA_CALLER_NAME) ?: "Unknown"
                callType = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "voice"
                startForegroundWithNotification(getString(R.string.call_connecting))
                acquireWakeLock()
                requestAudioFocus()
                Log.d(TAG, "Service started for call with $callerName")
            }
            ACTION_UPDATE -> {
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
                releaseWakeLock()
                abandonAudioFocus()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                Log.d(TAG, "Service stopped")
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
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
        startForeground(NOTIFICATION_ID, notification)
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

        val caller = androidx.core.app.Person.Builder()
            .setName(callerName)
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
            builder.setContentTitle(if (callType == "video") getString(R.string.call_video_call_with, callerName) else getString(R.string.call_voice_call_with, callerName))
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
