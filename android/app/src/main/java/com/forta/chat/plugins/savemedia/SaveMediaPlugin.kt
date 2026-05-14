package com.forta.chat.plugins.savemedia

import android.content.ContentValues
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileOutputStream

/**
 * Native Capacitor plugin for Session 58 — Save → Share regression fix.
 *
 * Writes media files via MediaStore.insert() so they land in the user-
 * visible gallery (Pictures/Forta Chat) or Downloads folder, instead of
 * cache (the prior FileOpener + Share fallback path silently degraded
 * to a Share dialog on Android 14+ scoped storage).
 *
 * On API 29+ (Q+) MediaStore RELATIVE_PATH avoids any runtime permission
 * grant. On API 28- the manifest already declares WRITE_EXTERNAL_STORAGE.
 */
@CapacitorPlugin(name = "SaveMedia")
class SaveMediaPlugin : Plugin() {

    companion object {
        /**
         * Resolve the MediaStore RELATIVE_PATH for a given MIME family.
         *
         * Image/video/audio go to their standard gallery roots so they are
         * picked up by the system Gallery / Music apps. Everything else
         * (PDF, archives, generic documents) falls back to Downloads.
         *
         * Hardcoded literal strings (rather than `Environment.DIRECTORY_*`)
         * keep this pure JVM-testable — `Environment` is unavailable in
         * JUnit unit tests without Robolectric. The values match Android's
         * documented constants: `Pictures`, `Movies`, `Music`, `Download`.
         */
        fun relativePathForMime(mime: String): String = when {
            mime.startsWith("image/") -> "Pictures/Forta Chat"
            mime.startsWith("video/") -> "Movies/Forta Chat"
            mime.startsWith("audio/") -> "Music/Forta Chat"
            else -> "Download/Forta Chat"
        }
    }

    @PluginMethod
    fun save(call: PluginCall) {
        val base64 = call.getString("base64")
            ?: return call.reject("base64 required")
        val fileName = call.getString("fileName")
            ?: return call.reject("fileName required")
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"

        try {
            val bytes = Base64.decode(base64, Base64.DEFAULT)
            val savedPath = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                writeViaMediaStore(fileName, mimeType, bytes)
            } else {
                writeViaLegacyStorage(fileName, mimeType, bytes)
            }

            val ret = JSObject()
            ret.put("uri", savedPath.uri)
            ret.put("path", savedPath.displayPath)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("save failed: ${e.message}", e)
        }
    }

    /** API 29+ scoped storage path — no runtime permission required. */
    private fun writeViaMediaStore(fileName: String, mimeType: String, bytes: ByteArray): SavedPath {
        val resolver = context.contentResolver
        val relativePath = relativePathForMime(mimeType)
        val collection = collectionForMime(mimeType)

        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val uri = resolver.insert(collection, values)
            ?: throw IllegalStateException("MediaStore insert returned null")

        try {
            resolver.openOutputStream(uri)?.use { out ->
                out.write(bytes)
                out.flush()
            } ?: throw IllegalStateException("openOutputStream returned null")

            // Clear IS_PENDING so the file becomes visible to other apps.
            val finalize = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            resolver.update(uri, finalize, null, null)
        } catch (e: Exception) {
            // Roll back the placeholder row so we don't leave half-written
            // entries lying around in the MediaStore index.
            try {
                resolver.delete(uri, null, null)
            } catch (_: Exception) {
                // best-effort cleanup
            }
            throw e
        }

        return SavedPath(uri = uri.toString(), displayPath = "$relativePath/$fileName")
    }

    /**
     * API 28 and below path. Writes directly to public external storage
     * via java.io.File. Requires WRITE_EXTERNAL_STORAGE (declared in the
     * manifest); runtime grant is the caller's responsibility on
     * API 23–28.
     */
    private fun writeViaLegacyStorage(fileName: String, mimeType: String, bytes: ByteArray): SavedPath {
        val rootDirName = when {
            mimeType.startsWith("image/") -> Environment.DIRECTORY_PICTURES
            mimeType.startsWith("video/") -> Environment.DIRECTORY_MOVIES
            mimeType.startsWith("audio/") -> Environment.DIRECTORY_MUSIC
            else -> Environment.DIRECTORY_DOWNLOADS
        }

        @Suppress("DEPRECATION")
        val rootDir = Environment.getExternalStoragePublicDirectory(rootDirName)
        val targetDir = File(rootDir, "Forta Chat")
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            throw IllegalStateException("Could not create directory: ${targetDir.absolutePath}")
        }

        val targetFile = File(targetDir, fileName)
        FileOutputStream(targetFile).use { out ->
            out.write(bytes)
            out.flush()
        }

        return SavedPath(
            uri = Uri.fromFile(targetFile).toString(),
            displayPath = "$rootDirName/Forta Chat/$fileName",
        )
    }

    private fun collectionForMime(mime: String): Uri = when {
        mime.startsWith("image/") ->
            MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        mime.startsWith("video/") ->
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        mime.startsWith("audio/") ->
            MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        else ->
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }

    private data class SavedPath(val uri: String, val displayPath: String)
}
