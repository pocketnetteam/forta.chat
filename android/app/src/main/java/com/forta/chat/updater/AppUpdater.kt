package com.forta.chat.updater

import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

// ---- Data model ----

data class GithubReleaseInfo(
    val versionName: String,
    val apkUrl: String
)

// ---- Main updater object ----

object AppUpdater {

    private const val TAG = "AppUpdater"

    // TODO: Replace with your actual GitHub owner/repo
    private const val GITHUB_OWNER = "pocketnetteam"
    private const val GITHUB_REPO = "new-bastyon-chat"
    private const val RELEASES_URL =
        "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/latest"

    private const val PREFS_NAME = "app_updater_prefs"
    private const val PREF_LAST_CHECK_TIME = "last_update_check_time"
    private const val PREF_LAST_SEEN_VERSION = "last_seen_version"

    private const val AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000L // 1 hour

    private const val NOTIFICATION_CHANNEL_ID = "update_download"
    private const val NOTIFICATION_ID = 9001

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // ---- Public API ----

    /**
     * Check for update. Call from MainActivity.onCreate with isManual=false,
     * or from "Check for updates" button with isManual=true.
     */
    suspend fun checkForUpdateIfNeeded(context: Context, isManual: Boolean) {
        try {
            if (!isManual && !isAutoCheckDue(context)) {
                Log.d(TAG, "Auto-check skipped: last check was less than 1 hour ago")
                return
            }

            val releaseInfo = fetchLatestReleaseInfo()

            // Update cache
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit()
                .putLong(PREF_LAST_CHECK_TIME, System.currentTimeMillis())
                .putString(PREF_LAST_SEEN_VERSION, releaseInfo.versionName)
                .apply()

            val currentVersion = getCurrentVersion(context)

            if (isVersionNewer(releaseInfo.versionName, currentVersion)) {
                Log.i(TAG, "New version available: ${releaseInfo.versionName} (current: $currentVersion)")
                withContext(Dispatchers.Main) {
                    showUpdateDialog(context, releaseInfo)
                }
            } else {
                Log.d(TAG, "App is up to date: $currentVersion")
                if (isManual) {
                    withContext(Dispatchers.Main) {
                        Toast.makeText(
                            context,
                            "Вы используете последнюю версию ($currentVersion)",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Update check failed", e)
            if (isManual) {
                withContext(Dispatchers.Main) {
                    Toast.makeText(
                        context,
                        "Не удалось проверить обновления: ${e.localizedMessage}",
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    // ---- Network ----

    private suspend fun fetchLatestReleaseInfo(): GithubReleaseInfo = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .get()
            .build()

        val response = httpClient.newCall(request).execute()

        if (!response.isSuccessful) {
            throw RuntimeException("GitHub API returned ${response.code}: ${response.message}")
        }

        val body = response.body?.string()
            ?: throw RuntimeException("Empty response body from GitHub API")

        val json = JSONObject(body)
        val tagName = json.getString("tag_name")
        val versionName = tagName.removePrefix("v")

        val assets = json.getJSONArray("assets")
        var apkUrl: String? = null

        for (i in 0 until assets.length()) {
            val asset = assets.getJSONObject(i)
            val name = asset.getString("name")
            if (name.endsWith(".apk")) {
                apkUrl = asset.getString("browser_download_url")
                break
            }
        }

        if (apkUrl == null) {
            throw RuntimeException("No APK asset found in latest release ($tagName)")
        }

        GithubReleaseInfo(versionName = versionName, apkUrl = apkUrl)
    }

    // ---- Version comparison ----

    private fun getCurrentVersion(context: Context): String {
        return try {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.versionName ?: "0.0.0"
        } catch (e: Exception) {
            "0.0.0"
        }
    }

    /**
     * Returns true if [remote] is strictly greater than [local].
     * Compares major.minor.patch numerically.
     */
    fun isVersionNewer(remote: String, local: String): Boolean {
        val remoteParts = remote.split(".").mapNotNull { it.toIntOrNull() }
        val localParts = local.split(".").mapNotNull { it.toIntOrNull() }

        val maxLen = maxOf(remoteParts.size, localParts.size)
        for (i in 0 until maxLen) {
            val r = remoteParts.getOrElse(i) { 0 }
            val l = localParts.getOrElse(i) { 0 }
            if (r > l) return true
            if (r < l) return false
        }
        return false // equal
    }

    // ---- Cache ----

    private fun isAutoCheckDue(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastCheck = prefs.getLong(PREF_LAST_CHECK_TIME, 0L)
        return System.currentTimeMillis() - lastCheck >= AUTO_CHECK_INTERVAL_MS
    }

    // ---- UI ----

    private fun showUpdateDialog(context: Context, releaseInfo: GithubReleaseInfo) {
        AlertDialog.Builder(context)
            .setTitle("Доступно обновление")
            .setMessage("Новая версия ${releaseInfo.versionName} доступна для загрузки. Обновить сейчас?")
            .setPositiveButton("Обновить") { _, _ ->
                // Check if install from unknown sources is allowed (Android 8+)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (!context.packageManager.canRequestPackageInstalls()) {
                        // Redirect user to enable install from this source
                        Toast.makeText(
                            context,
                            "Разрешите установку из этого источника, затем попробуйте снова",
                            Toast.LENGTH_LONG
                        ).show()
                        val intent = Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            android.net.Uri.parse("package:${context.packageName}")
                        )
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        context.startActivity(intent)
                        return@setPositiveButton
                    }
                }

                // Start download in background
                @Suppress("OPT_IN_USAGE")
                GlobalScope.launch(Dispatchers.IO) {
                    downloadAndInstallApk(context, releaseInfo.apkUrl)
                }
            }
            .setNegativeButton("Позже", null)
            .show()
    }

    // ---- Download & Install ----

    suspend fun downloadAndInstallApk(context: Context, apkUrl: String) {
        try {
            createNotificationChannel(context)

            val notificationManager =
                context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

            val builder = NotificationCompat.Builder(context, NOTIFICATION_CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentTitle("Загрузка обновления")
                .setContentText("Скачивание...")
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setProgress(100, 0, false)

            notificationManager.notify(NOTIFICATION_ID, builder.build())

            withContext(Dispatchers.IO) {
                val request = Request.Builder()
                    .url(apkUrl)
                    .build()

                val response = httpClient.newCall(request).execute()

                if (!response.isSuccessful) {
                    throw RuntimeException("Download failed: ${response.code}")
                }

                val body = response.body ?: throw RuntimeException("Empty download body")
                val contentLength = body.contentLength()

                // Save to app's external files directory (accessible via FileProvider)
                val updatesDir = File(context.getExternalFilesDir(null), "updates")
                if (!updatesDir.exists()) updatesDir.mkdirs()

                val apkFile = File(updatesDir, "forta-chat-update.apk")

                body.byteStream().use { input ->
                    FileOutputStream(apkFile).use { output ->
                        val buffer = ByteArray(8192)
                        var bytesRead: Long = 0
                        var read: Int

                        while (input.read(buffer).also { read = it } != -1) {
                            output.write(buffer, 0, read)
                            bytesRead += read

                            if (contentLength > 0) {
                                val progress = (bytesRead * 100 / contentLength).toInt()
                                builder.setProgress(100, progress, false)
                                    .setContentText("Скачано $progress%")
                                notificationManager.notify(NOTIFICATION_ID, builder.build())
                            }
                        }
                    }
                }

                // Download complete — update notification
                withContext(Dispatchers.Main) {
                    notificationManager.cancel(NOTIFICATION_ID)
                }

                // Verify downloaded version before installing
                val downloadedVersion = getApkVersionName(context, apkFile)
                val currentVersion = getCurrentVersion(context)
                if (downloadedVersion != null && !isVersionNewer(downloadedVersion, currentVersion)) {
                    Log.w(TAG, "Downloaded APK version ($downloadedVersion) is not newer than current ($currentVersion). Aborting install.")
                    apkFile.delete()
                    return@withContext
                }

                // Install the APK
                withContext(Dispatchers.Main) {
                    installApk(context, apkFile)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Download/install failed", e)
            withContext(Dispatchers.Main) {
                val notificationManager =
                    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                notificationManager.cancel(NOTIFICATION_ID)

                Toast.makeText(
                    context,
                    "Ошибка загрузки обновления: ${e.localizedMessage}",
                    Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    private fun installApk(context: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile
        )

        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        context.startActivity(intent)
    }

    private fun getApkVersionName(context: Context, apkFile: File): String? {
        return try {
            val info = context.packageManager.getPackageArchiveInfo(apkFile.absolutePath, 0)
            info?.versionName
        } catch (e: Exception) {
            null
        }
    }

    // ---- Notifications ----

    private fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "Обновление приложения",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Прогресс загрузки обновления"
            }

            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }
}
