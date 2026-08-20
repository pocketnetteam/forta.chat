package com.forta.chat.plugins.download

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * JS bridge for `ModelDownloadService` — see that class's doc comment for
 * why this exists (background survival for the local-AI model download,
 * `docs/decisions.md`'s "background download" entry). `local-ai`'s
 * `DownloadTransportPort` contract (`start`/`pause`/`resume`/`stop`/
 * `status`/`onProgress`/`onCompleted`/`onFailed`) is implemented on the JS
 * side by `NativeForegroundDownloadAdapter`
 * (`src/entities/local-ai/lib/native-foreground-download.adapter.ts`),
 * which calls this plugin 1:1.
 */
@CapacitorPlugin(name = "ModelDownloader")
class ModelDownloadPlugin : Plugin() {

    override fun load() {
        // Same in-process static-callback pattern as CallPlugin.load()
        // wiring up CallConnection.onAnswered/onRejected/onEnded.
        ModelDownloadService.listener = object : ModelDownloadService.Listener {
            override fun onProgress(id: String, percent: Int) {
                notifyListeners(
                    "progress",
                    JSObject().apply {
                        put("id", id)
                        put("progressPercent", percent)
                    },
                )
            }

            override fun onCompleted(id: String) {
                notifyListeners("completed", JSObject().apply { put("id", id) })
            }

            override fun onFailed(id: String, error: String) {
                notifyListeners(
                    "failed",
                    JSObject().apply {
                        put("id", id)
                        put("error", error)
                    },
                )
            }
        }
    }

    /** Also doubles as "resume" — see `ModelDownloadService`'s doc comment:
     *  starting again with the same `destinationPath` naturally continues
     *  from however many bytes are already there. */
    @PluginMethod
    fun start(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id required"); return }
        val url = call.getString("url") ?: run { call.reject("url required"); return }
        val destinationPath = call.getString("destinationPath") ?: run { call.reject("destinationPath required"); return }
        val headersJson = call.getObject("headers")?.toString() ?: "{}"

        ModelDownloadService.start(context, id, url, destinationPath, headersJson)
        call.resolve()
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id required"); return }
        ModelDownloadService.pause(context, id)
        call.resolve()
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id required"); return }
        ModelDownloadService.stop(context, id)
        call.resolve()
    }

    @PluginMethod
    fun status(call: PluginCall) {
        call.resolve(
            JSObject().apply {
                put("state", ModelDownloadService.currentState)
                put("progressPercent", ModelDownloadService.currentPercent)
                ModelDownloadService.currentError?.let { put("errorMessage", it) }
            },
        )
    }

    /**
     * Native-speed SHA-256 of the downloaded model — local-ai's
     * `FastVerifyPort` (`src/entities/local-ai/lib/native-fast-verify.adapter.ts`
     * implements it via this method). Exists because the portable
     * `readChunks()`-through-the-Filesystem-bridge path
     * (`local-ai`'s `checksum.ts`) is fine for small files but was
     * confirmed live (2026-08-19) to take on the order of two HOURS for a
     * 2.3GB model — each chunk is its own JS↔native round-trip with a
     * base64 encode/decode on top. Reading the file directly with a plain
     * `FileInputStream` and hashing with `MessageDigest` avoids the bridge
     * entirely; this takes low single-digit seconds on real hardware.
     *
     * `path` follows the same convention as `ModelDownloadService`'s
     * `destinationPath` — a `CapacitorFsAdapter.resolvePath()` relative
     * path meant to be resolved against `Directory.DATA` (`context.filesDir`),
     * not a real filesystem path on its own (see that class's doc comment
     * on the exact bug this convention mismatch caused once already).
     */
    @PluginMethod
    fun verify(call: PluginCall) {
        val id = call.getString("id") ?: run { call.reject("id required"); return }
        val path = call.getString("path") ?: run { call.reject("path required"); return }
        val expectedSha256 = call.getString("expectedSha256") ?: run { call.reject("expectedSha256 required"); return }

        val filesDir = context.filesDir
        // Same background-thread + notifyListeners()-from-a-thread pattern
        // TorFilePlugin.kt's upload()/download() already use successfully.
        Thread {
            try {
                val file = File(filesDir, path)
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(1 shl 20) // 1MB — plenty for a local disk read, no bridge round-trips to amortize here
                val totalBytes = file.length()
                var bytesRead: Int
                var totalRead = 0L
                var lastReportedPercent = -1

                FileInputStream(file).use { input ->
                    while (input.read(buffer).also { bytesRead = it } != -1) {
                        digest.update(buffer, 0, bytesRead)
                        totalRead += bytesRead
                        if (totalBytes > 0) {
                            val percent = ((totalRead * 100) / totalBytes).toInt().coerceIn(0, 100)
                            if (percent != lastReportedPercent) {
                                lastReportedPercent = percent
                                notifyListeners(
                                    "verifyProgress",
                                    JSObject().apply {
                                        put("id", id)
                                        put("bytesHashed", totalRead)
                                    },
                                )
                            }
                        }
                    }
                }

                val actualHex = digest.digest().joinToString("") { "%02x".format(it) }
                call.resolve(JSObject().apply { put("valid", actualHex.equals(expectedSha256, ignoreCase = true)) })
            } catch (e: Exception) {
                call.reject("verify failed: ${e.message}", e)
            }
        }.start()
    }
}
