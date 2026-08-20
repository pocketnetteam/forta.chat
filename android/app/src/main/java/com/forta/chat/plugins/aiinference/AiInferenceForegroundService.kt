package com.forta.chat.plugins.aiinference

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.forta.chat.R

/**
 * Pure keep-alive foreground service for an in-flight local-AI reply —
 * unlike `ModelDownloadService`, this service does no work of its own.
 * Token generation already runs natively inside `llama-cpp-pro`'s own plugin
 * on its own thread (confirmed on a real device via logcat's per-token
 * `LlamaCpp`/`RNLlama` logging — see `local-ai`'s
 * `llama-cpp-capacitor.adapter.ts` doc comment), so there is nothing for
 * this service to drive. Its only job is holding a foreground notification
 * up for the duration of `client.sendMessage()`/`complete()` so Android
 * doesn't deprioritize or kill the whole process while a reply streams and
 * the user has switched away — same reasoning `ModelDownloadService` exists
 * for downloads, and `CallForegroundService` for calls (see
 * `docs/plans/llama2/decisions.md`'s "AI-chat background generation" entry).
 *
 * `foregroundServiceType="dataSync"` — reuses the same type
 * `ModelDownloadService` already declares (see that class's own comment on
 * why); no new manifest permission needed.
 *
 * Single-generation design, same reasoning as `ModelDownloadService`:
 * `local-ai`'s `RuntimeFacade` only ever allows one `complete()` at a time
 * (`RuntimeBusyError`), so there is never more than one AI reply generating
 * across the whole app — no per-task bookkeeping needed, just start/stop.
 */
class AiInferenceForegroundService : Service() {

    companion object {
        private const val TAG = "AiInferenceForegroundService"
        private const val CHANNEL_ID = "ai_inference"
        private const val NOTIFICATION_ID = 20002

        const val ACTION_START = "com.forta.chat.AI_INFERENCE_START"
        const val ACTION_STOP = "com.forta.chat.AI_INFERENCE_STOP"

        fun start(context: Context) {
            val intent = Intent(context, AiInferenceForegroundService::class.java).apply { action = ACTION_START }
            try {
                context.startForegroundService(intent)
            } catch (e: Throwable) {
                // Same defensive pattern as ModelDownloadService.start()/
                // CallForegroundService.start() — Android 12+ can reject a
                // background-started FGS on some OEM builds. Non-fatal here:
                // generation still runs (it's native, not owned by this
                // service), the process just loses the extra survival
                // margin the notification would have bought it.
                Log.e(TAG, "startForegroundService rejected", e)
            }
        }

        fun stop(context: Context) {
            runCatching {
                context.startService(Intent(context, AiInferenceForegroundService::class.java).apply { action = ACTION_STOP })
            }.onFailure { Log.w(TAG, "stop: startService failed (service likely not running)", it) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> startForegroundWithNotification()
            ACTION_STOP -> {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Same reasoning as ModelDownloadService — the whole point of this
        // service is to keep the process alive when the app is swiped
        // away/backgrounded, do NOT stop here.
        super.onTaskRemoved(rootIntent)
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_ai_inference),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.channel_ai_inference_desc)
            setSound(null, null)
            enableVibration(false)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification() {
        val notification = buildNotification()
        // Android 14+ (API 34) requires a foreground-service type at
        // startForeground time — same requirement ModelDownloadService/
        // CallForegroundService already hit (#640/#623/#624).
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            try {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
                return
            } catch (e: Throwable) {
                Log.e(TAG, "typed startForeground rejected, retrying untyped", e)
            }
        }
        try {
            startForeground(NOTIFICATION_ID, notification)
        } catch (e: Throwable) {
            Log.e(TAG, "startForeground also failed; service will run without FGS", e)
        }
    }

    private fun buildNotification(): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(getString(R.string.ai_inference_notification_title))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build()
    }
}
