package com.forta.chat.plugins.filetransfer

import android.net.Uri
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.*
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URL

@CapacitorPlugin(name = "TorFile")
class TorFilePlugin : Plugin() {

    companion object {
        private const val TAG = "TorFilePlugin"
        private const val PROXY_PORT = 8181
        private const val BUFFER_SIZE = 8192
    }

    @PluginMethod
    fun upload(call: PluginCall) {
        val filePath = call.getString("filePath") ?: run {
            call.reject("filePath required"); return
        }
        val uploadUrl = call.getString("uploadUrl") ?: run {
            call.reject("uploadUrl required"); return
        }
        val mimeType = call.getString("mimeType") ?: "application/octet-stream"
        val authHeader = call.getString("authorization") ?: ""

        Thread {
            try {
                val uri = Uri.parse(filePath)
                val inputStream: InputStream = if (uri.scheme == "content" || uri.scheme == "file") {
                    context.contentResolver.openInputStream(uri)
                        ?: throw IOException("Cannot open: $filePath")
                } else {
                    FileInputStream(File(filePath))
                }

                val fileSize = inputStream.available().toLong()

                val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", PROXY_PORT))
                val url = URL(uploadUrl)
                val conn = url.openConnection(proxy) as HttpURLConnection

                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", mimeType)
                conn.setRequestProperty("Content-Length", fileSize.toString())
                if (authHeader.isNotEmpty()) {
                    conn.setRequestProperty("Authorization", authHeader)
                }
                conn.setChunkedStreamingMode(BUFFER_SIZE)

                val outputStream = conn.outputStream
                val buffer = ByteArray(BUFFER_SIZE)
                var uploaded = 0L
                var bytesRead: Int

                inputStream.use { input ->
                    outputStream.use { output ->
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            uploaded += bytesRead

                            if (fileSize > 0) {
                                val percent = (uploaded * 100 / fileSize).toInt()
                                notifyListeners("progress", JSObject().apply {
                                    put("percent", percent)
                                    put("loaded", uploaded)
                                    put("total", fileSize)
                                })
                            }
                        }
                    }
                }

                val responseCode = conn.responseCode
                if (responseCode in 200..299) {
                    val responseBody = conn.inputStream.bufferedReader().readText()
                    call.resolve(JSObject().apply {
                        put("contentUri", responseBody)
                        put("statusCode", responseCode)
                    })
                } else {
                    call.reject("Upload failed: HTTP $responseCode")
                }

                conn.disconnect()
            } catch (e: Exception) {
                Log.e(TAG, "Upload error", e)
                call.reject("Upload failed: ${e.message}", e)
            }
        }.start()
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val url = call.getString("url") ?: run {
            call.reject("url required"); return
        }
        val authHeader = call.getString("authorization") ?: ""

        Thread {
            try {
                val proxy = Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", PROXY_PORT))
                val conn = URL(url).openConnection(proxy) as HttpURLConnection

                if (authHeader.isNotEmpty()) {
                    conn.setRequestProperty("Authorization", authHeader)
                }

                val responseCode = conn.responseCode
                if (responseCode !in 200..299) {
                    call.reject("Download failed: HTTP $responseCode")
                    return@Thread
                }

                val contentLength = conn.contentLengthLong
                val ext = guessMimeExtension(conn.contentType ?: "application/octet-stream")
                val outFile = File(context.cacheDir, "download_${System.currentTimeMillis()}$ext")

                conn.inputStream.use { input ->
                    outFile.outputStream().use { output ->
                        val buffer = ByteArray(BUFFER_SIZE)
                        var downloaded = 0L
                        var bytesRead: Int
                        while (input.read(buffer).also { bytesRead = it } != -1) {
                            output.write(buffer, 0, bytesRead)
                            downloaded += bytesRead
                            if (contentLength > 0) {
                                notifyListeners("progress", JSObject().apply {
                                    put("percent", (downloaded * 100 / contentLength).toInt())
                                    put("loaded", downloaded)
                                    put("total", contentLength)
                                })
                            }
                        }
                    }
                }

                conn.disconnect()

                call.resolve(JSObject().apply {
                    put("filePath", outFile.absolutePath)
                    put("mimeType", conn.contentType)
                    put("size", outFile.length())
                })
            } catch (e: Exception) {
                Log.e(TAG, "Download error", e)
                call.reject("Download failed: ${e.message}", e)
            }
        }.start()
    }

    private fun guessMimeExtension(mime: String): String = when {
        mime.contains("jpeg") || mime.contains("jpg") -> ".jpg"
        mime.contains("png") -> ".png"
        mime.contains("gif") -> ".gif"
        mime.contains("webp") -> ".webp"
        mime.contains("mp4") -> ".mp4"
        mime.contains("webm") -> ".webm"
        mime.contains("ogg") -> ".ogg"
        mime.contains("pdf") -> ".pdf"
        else -> ".bin"
    }
}
