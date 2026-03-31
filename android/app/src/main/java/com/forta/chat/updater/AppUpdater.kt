package com.forta.chat.updater

import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.FileProvider
import com.forta.chat.R
import com.forta.chat.plugins.locale.LocaleHelper
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
    val apkUrl: String,
    val releasePageUrl: String
)

// ---- Main updater object ----

object AppUpdater {

    private const val TAG = "AppUpdater"

    private const val GITHUB_OWNER = "greenShirtMystery"
    private const val GITHUB_REPO = "forta.chat"
    private const val RELEASES_URL =
        "https://api.github.com/repos/$GITHUB_OWNER/$GITHUB_REPO/releases/latest"

    private const val PREFS_NAME = "app_updater_prefs"
    private const val PREF_LAST_CHECK_TIME = "last_update_check_time"
    private const val PREF_LAST_SEEN_VERSION = "last_seen_version"

    private const val AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000L // 1 hour

    // Short timeouts for API calls
    private val apiClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    // Longer timeouts + explicit redirect following for APK download
    private val downloadClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.MINUTES)
        .followRedirects(true)
        .followSslRedirects(true)
        .build()

    // ---- Public API ----

    suspend fun checkForUpdateIfNeeded(context: Context, isManual: Boolean) {
        // Localized context for getString() — keeps Activity token from original context for dialogs
        val lc = LocaleHelper.wrapContext(context)
        try {
            if (!isManual && !isAutoCheckDue(context)) {
                Log.d(TAG, "Auto-check skipped: last check was less than 1 hour ago")
                return
            }

            val releaseInfo = fetchLatestReleaseInfo()

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
                            lc.getString(R.string.updater_up_to_date, currentVersion),
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
                        lc.getString(R.string.updater_check_failed, e.localizedMessage),
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

        val response = apiClient.newCall(request).execute()
        response.use { resp ->
            if (!resp.isSuccessful) {
                throw RuntimeException("GitHub API returned ${resp.code}: ${resp.message}")
            }

            val body = resp.body?.string()
                ?: throw RuntimeException("Empty response body from GitHub API")

            val json = JSONObject(body)
            val tagName = json.getString("tag_name")
            val versionName = tagName.removePrefix("v")
            val releasePageUrl = json.getString("html_url")

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

            GithubReleaseInfo(
                versionName = versionName,
                apkUrl = apkUrl,
                releasePageUrl = releasePageUrl
            )
        }
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
        return false
    }

    // ---- Cache ----

    private fun isAutoCheckDue(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastCheck = prefs.getLong(PREF_LAST_CHECK_TIME, 0L)
        return System.currentTimeMillis() - lastCheck >= AUTO_CHECK_INTERVAL_MS
    }

    // ---- UI ----

    private fun showUpdateDialog(context: Context, releaseInfo: GithubReleaseInfo) {
        val lc = LocaleHelper.wrapContext(context)
        AlertDialog.Builder(context)
            .setTitle(lc.getString(R.string.updater_available_title))
            .setMessage(lc.getString(R.string.updater_available_message, releaseInfo.versionName))
            .setPositiveButton(lc.getString(R.string.updater_update)) { _, _ ->
                // Always download and try to install — Android will prompt for
                // "install from unknown sources" permission if needed
                startDownloadWithProgressDialog(context, releaseInfo)
            }
            .setNeutralButton(lc.getString(R.string.updater_open_browser)) { _, _ ->
                openReleasePage(context, releaseInfo.releasePageUrl)
            }
            .setNegativeButton(lc.getString(R.string.updater_later), null)
            .show()
    }

    private fun openReleasePage(context: Context, url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    // ---- Download with progress dialog ----

    private fun startDownloadWithProgressDialog(context: Context, releaseInfo: GithubReleaseInfo) {
        val lc = LocaleHelper.wrapContext(context)
        // Build progress dialog layout
        val padding = (24 * context.resources.displayMetrics.density).toInt()
        val layout = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding / 2)
        }

        val progressBar = ProgressBar(context, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            progress = 0
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        val progressText = TextView(context).apply {
            text = lc.getString(R.string.updater_preparing)
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = (12 * context.resources.displayMetrics.density).toInt()
            }
        }

        layout.addView(progressBar)
        layout.addView(progressText)

        val dialog = AlertDialog.Builder(context)
            .setTitle(lc.getString(R.string.updater_downloading_title, releaseInfo.versionName))
            .setView(layout)
            .setCancelable(false)
            .setNegativeButton(lc.getString(R.string.updater_cancel), null)
            .create()

        dialog.show()

        @Suppress("OPT_IN_USAGE")
        GlobalScope.launch(Dispatchers.IO) {
            try {
                val apkFile = downloadApk(context, releaseInfo.apkUrl) { percent ->
                    launch(Dispatchers.Main) {
                        progressBar.progress = percent
                        progressText.text = lc.getString(R.string.updater_downloaded_percent, percent)
                    }
                }

                withContext(Dispatchers.Main) {
                    dialog.dismiss()
                }

                // Verify version
                val downloadedVersion = getApkVersionName(context, apkFile)
                val currentVersion = getCurrentVersion(context)
                if (downloadedVersion != null && !isVersionNewer(downloadedVersion, currentVersion)) {
                    Log.w(TAG, "Downloaded APK ($downloadedVersion) not newer than current ($currentVersion)")
                    apkFile.delete()
                    return@launch
                }

                withContext(Dispatchers.Main) {
                    installApk(context, apkFile)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Download failed", e)
                withContext(Dispatchers.Main) {
                    dialog.dismiss()
                    Toast.makeText(
                        context,
                        lc.getString(R.string.updater_download_error, e.localizedMessage),
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
        }
    }

    // ---- Download ----

    private fun downloadApk(
        context: Context,
        apkUrl: String,
        onProgress: (Int) -> Unit
    ): File {
        val request = Request.Builder()
            .url(apkUrl)
            .build()

        val response = downloadClient.newCall(request).execute()

        if (!response.isSuccessful) {
            response.close()
            throw RuntimeException("Download failed: ${response.code}")
        }

        val body = response.body ?: run {
            response.close()
            throw RuntimeException("Empty download body")
        }

        val contentLength = body.contentLength()

        val updatesDir = File(context.getExternalFilesDir(null), "updates")
        if (!updatesDir.exists()) updatesDir.mkdirs()
        val apkFile = File(updatesDir, "forta-chat-update.apk")

        body.byteStream().use { input ->
            FileOutputStream(apkFile).use { output ->
                val buffer = ByteArray(8192)
                var bytesRead: Long = 0
                var lastReportedPercent = -1
                var read: Int

                while (input.read(buffer).also { read = it } != -1) {
                    output.write(buffer, 0, read)
                    bytesRead += read

                    if (contentLength > 0) {
                        val percent = (bytesRead * 100 / contentLength).toInt()
                        if (percent != lastReportedPercent) {
                            lastReportedPercent = percent
                            onProgress(percent)
                        }
                    }
                }
            }
        }

        return apkFile
    }

    // ---- Install ----

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
}
