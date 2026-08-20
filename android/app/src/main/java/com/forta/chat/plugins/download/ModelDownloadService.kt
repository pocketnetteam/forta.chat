package com.forta.chat.plugins.download

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
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Foreground service that downloads the local-AI model via chunked `Range:`
 * requests — the JS-side `CapacitorRangeDownloadAdapter` (`local-ai`) does
 * the same byte-offset-resume logic, but as a pure WebView JS loop, which
 * Android throttles/kills once the app is backgrounded (see
 * docs/decisions.md's "background download" entry). Running the same loop
 * inside a real foreground service — same pattern as `CallForegroundService`
 * for calls — lets the transfer survive the user switching to another app,
 * same as `CallForegroundService` does for an active call.
 *
 * Single-task design: this app only ever downloads one model at a time
 * (`DownloadEngine`/`LocalAiClient` never issue concurrent model downloads),
 * so unlike `CapacitorRangeDownloadAdapter`'s `Map<string, TaskRecord>` this
 * keeps exactly one task's state in static fields — simpler, and there is
 * no real multi-task requirement to justify the extra bookkeeping.
 *
 * "Resume" is not a distinct action here — `ACTION_START` itself reads
 * however many bytes are already at `destinationPath` and requests
 * `Range: bytes=<existing>-`, so calling start() again after a pause IS the
 * resume (mirrors `CapacitorRangeDownloadAdapter.resume()`, which just calls
 * its own `runDownload()` again for the same reason).
 */
class ModelDownloadService : Service() {

    /** Declared here (not inside `companion object`) so it resolves plainly
     *  as `ModelDownloadService.Listener` from `ModelDownloadPlugin` —
     *  a nested type declared inside a companion object would instead
     *  require the awkward `ModelDownloadService.Companion.Listener`. */
    interface Listener {
        fun onProgress(id: String, percent: Int)
        fun onCompleted(id: String)
        fun onFailed(id: String, error: String)
    }

    companion object {
        private const val TAG = "ModelDownloadService"
        private const val CHANNEL_ID = "model_download"
        private const val NOTIFICATION_ID = 20001
        private const val BUFFER_SIZE = 8192

        const val ACTION_START = "com.forta.chat.MODEL_DOWNLOAD_START"
        const val ACTION_PAUSE = "com.forta.chat.MODEL_DOWNLOAD_PAUSE"
        const val ACTION_STOP = "com.forta.chat.MODEL_DOWNLOAD_STOP"

        const val EXTRA_ID = "id"
        const val EXTRA_URL = "url"
        const val EXTRA_DESTINATION_PATH = "destinationPath"
        const val EXTRA_HEADERS_JSON = "headersJson"

        /** Set by `ModelDownloadPlugin.load()` — same in-process callback
         *  pattern as `CallConnection.onAnswered` etc. in the calls plugin. */
        @Volatile
        var listener: Listener? = null

        // Synchronous, in-memory "last known state" for the plugin's
        // status() method — no need to bind to the service just to answer
        // "what's it doing right now".
        @Volatile
        var currentId: String? = null
        @Volatile
        var currentState: String = "pending" // pending | running | paused | done | error
        @Volatile
        var currentPercent: Int = 0
        @Volatile
        var currentError: String? = null

        fun start(context: Context, id: String, url: String, destinationPath: String, headersJson: String) {
            val intent = Intent(context, ModelDownloadService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_ID, id)
                putExtra(EXTRA_URL, url)
                putExtra(EXTRA_DESTINATION_PATH, destinationPath)
                putExtra(EXTRA_HEADERS_JSON, headersJson)
            }
            try {
                context.startForegroundService(intent)
            } catch (e: Throwable) {
                // Same defensive pattern as CallForegroundService.start() —
                // Android 12+ can reject a background-started FGS on some
                // OEM builds. Surfaced to JS as a download:failed via the
                // adapter's own timeout/no-progress handling rather than a
                // crash here.
                Log.e(TAG, "startForegroundService rejected", e)
                currentState = "error"
                currentError = "startForegroundService rejected: ${e.message}"
                listener?.onFailed(id, currentError!!)
            }
        }

        fun pause(context: Context, id: String) {
            if (currentId != null && currentId != id) return // stale call for a different/finished task
            runCatching {
                context.startService(Intent(context, ModelDownloadService::class.java).apply { action = ACTION_PAUSE })
            }.onFailure { Log.w(TAG, "pause: startService failed (service likely not running)", it) }
        }

        /** File deletion (when the caller wants `discardPartial`) is NOT this
         *  service's job — `DownloadEngine.cancel()`/`NativeForegroundDownloadAdapter.stop()`
         *  (JS side, `FileSystemPort`) delete the file themselves, the same
         *  way they would for any other transport. This just stops writing
         *  to it and tears the service down. */
        fun stop(context: Context, id: String) {
            if (currentId != null && currentId != id) return
            runCatching {
                context.startService(Intent(context, ModelDownloadService::class.java).apply { action = ACTION_STOP })
            }.onFailure { Log.w(TAG, "stop: startService failed (service likely not running)", it) }
        }
    }

    @Volatile
    private var cancelled = false
    @Volatile
    private var activeConnection: HttpURLConnection? = null
    private var downloadThread: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val id = intent.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
                val url = intent.getStringExtra(EXTRA_URL) ?: return START_NOT_STICKY
                val destinationPath = intent.getStringExtra(EXTRA_DESTINATION_PATH) ?: return START_NOT_STICKY
                val headersJson = intent.getStringExtra(EXTRA_HEADERS_JSON) ?: "{}"

                cancelled = false
                currentId = id
                currentState = "running"
                currentError = null
                startForegroundWithNotification(currentPercent)

                downloadThread = Thread {
                    runDownload(id, url, destinationPath, headersJson)
                }.also { it.start() }
            }
            ACTION_PAUSE -> {
                cancelled = true
                activeConnection?.disconnect() // unblocks a stream read() that's mid-wait, see runDownload()'s catch
                currentState = "paused"
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
            ACTION_STOP -> {
                cancelled = true
                activeConnection?.disconnect()
                currentId = null
                currentState = "pending"
                currentPercent = 0
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        cancelled = true
        activeConnection?.disconnect()
        super.onDestroy()
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Unlike CallForegroundService, the whole point of this service is
        // to keep running when the app is swiped away/backgrounded — do NOT
        // stop the download here. The foreground service + notification are
        // exactly what should keep the process alive through this.
        super.onTaskRemoved(rootIntent)
    }

    private fun runDownload(id: String, urlStr: String, destinationPath: String, headersJson: String) {
        var success = false
        try {
            // destinationPath is CapacitorFsAdapter.resolvePath()'s output — a
            // plain relative path ("models/x.gguf") meant to be paired with
            // Directory.DATA when calling the Filesystem plugin, NOT a real
            // filesystem path on its own (confirmed against
            // @capacitor/filesystem's own Android source,
            // LegacyFilesystemImplementation.kt: Directory.DATA -> filesDir).
            // Passing it straight to java.io.File() resolves against the
            // process's cwd instead and fails with ENOENT — this exact bug,
            // caught live on-device.
            val file = File(applicationContext.filesDir, destinationPath)
            file.parentFile?.mkdirs()
            var bytesSoFar = if (file.exists()) file.length() else 0L

            val headers = try {
                JSONObject(headersJson)
            } catch (e: Exception) {
                JSONObject()
            }

            val conn = URL(urlStr).openConnection() as HttpURLConnection
            activeConnection = conn
            conn.requestMethod = "GET"
            conn.connectTimeout = 30_000
            conn.readTimeout = 60_000
            conn.setRequestProperty("Range", "bytes=$bytesSoFar-")
            val keys = headers.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                conn.setRequestProperty(key, headers.getString(key))
            }

            val responseCode = conn.responseCode
            if (responseCode != HttpURLConnection.HTTP_PARTIAL) {
                // Server ignored/doesn't support Range — fail closed rather
                // than risk appending a full-content response on top of
                // existing bytes. Same contract as
                // CapacitorRangeDownloadAdapter's fail-closed check.
                throw IOException("server does not support Range requests (status $responseCode, expected 206)")
            }

            val contentRange = conn.getHeaderField("Content-Range") // "bytes X-Y/TOTAL"
            val totalBytes = contentRange?.substringAfterLast('/')?.toLongOrNull()

            val buffer = ByteArray(BUFFER_SIZE)
            var lastReportedPercent = -1

            conn.inputStream.use { input ->
                FileOutputStream(file, /* append = */ true).use { output ->
                    while (true) {
                        if (cancelled) return
                        val bytesRead = input.read(buffer)
                        if (bytesRead == -1) break
                        output.write(buffer, 0, bytesRead)
                        bytesSoFar += bytesRead

                        if (totalBytes != null && totalBytes > 0) {
                            val percent = ((bytesSoFar * 100) / totalBytes).toInt().coerceIn(0, 100)
                            if (percent != lastReportedPercent) {
                                lastReportedPercent = percent
                                currentPercent = percent
                                listener?.onProgress(id, percent)
                                if (percent % 2 == 0) updateNotification(percent)
                            }
                        }
                    }
                }
            }
            conn.disconnect()
            activeConnection = null

            if (cancelled) return

            success = true
            currentState = "done"
            currentPercent = 100
            listener?.onCompleted(id)
        } catch (e: Exception) {
            if (cancelled) return // pause()/stop() closing the connection surfaces as an IOException here — not a real failure
            Log.e(TAG, "Download failed", e)
            currentState = "error"
            currentError = e.message ?: "unknown error"
            listener?.onFailed(id, currentError!!)
        } finally {
            activeConnection = null
            if (!cancelled || success) {
                // A genuine pause()/stop() already called stopForeground()/
                // stopSelf() itself from onStartCommand — only tear down
                // here for the natural completion/failure paths, so a
                // pause doesn't race itself into calling stopSelf() twice.
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.channel_model_download),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.channel_model_download_desc)
            setSound(null, null)
            enableVibration(false)
        }
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(channel)
    }

    private fun startForegroundWithNotification(percent: Int) {
        val notification = buildNotification(percent)
        // Android 14+ (API 34) requires a foreground-service type at
        // startForeground time — same requirement CallForegroundService
        // hit for calls (#640/#623/#624). "dataSync" is the type Android
        // documents for exactly this (downloading/uploading data).
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
            runCatching {
                val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.notify(NOTIFICATION_ID, notification)
            }
        }
    }

    private fun updateNotification(percent: Int) {
        val notification = buildNotification(percent)
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    private fun buildNotification(percent: Int): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(getString(R.string.model_download_title))
            .setContentText(getString(R.string.model_download_progress, percent))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .build()
    }
}
