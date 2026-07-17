package com.forta.chat.plugins.tor

import android.util.Log
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

/**
 * Decides whether a URL should be routed through Tor reverse proxy.
 * Ported from electron/tor/transports.cjs (hasDirectAccess + isTorNeeded).
 */
class TorRouteDecider {

    private data class AccessRecord(
        var accessOk: Boolean = false,
        var nextTry: Long = 0,
        @Volatile var inProgress: java.util.concurrent.CompletableFuture<Boolean>? = null,
    )

    private val accessRecords = ConcurrentHashMap<String, AccessRecord>()
    private val lock = Any()

    fun isUseWithTor(url: String, mode: TorMode, torReady: Boolean): Boolean {
        if (mode == TorMode.NEVER) return false
        if (mode == TorMode.ALWAYS) return torReady

        // AUTO: use Tor when direct access to host is unavailable
        val useDirectAccess = hasDirectAccessSync(url)
        return !useDirectAccess && torReady
    }

    private fun hasDirectAccessSync(url: String): Boolean {
        val parsed = try {
            URL(url)
        } catch (e: Exception) {
            Log.d(TAG, "Invalid URL for routing: $url")
            return true
        }

        var port = parsed.port
        if (port == -1) {
            port = if (parsed.protocol == "https") 443 else 80
        }

        val hostname = parsed.host ?: return true

        if (isLocalAddress(hostname)) return true

        synchronized(lock) {
            val record = accessRecords.getOrPut(hostname) { AccessRecord() }

            val pending = record.inProgress
            if (pending != null) {
                return try {
                    pending.get()
                } catch (e: Exception) {
                    false
                }
            }

            val now = System.currentTimeMillis()
            if (record.nextTry > 0 && now >= record.nextTry) {
                val result = pingHost(hostname, port)
                record.accessOk = result
                record.nextTry = now + if (result) RETRY_OK_MS else RETRY_FAIL_MS
                return result
            }

            if (record.nextTry == 0L) {
                val future = java.util.concurrent.CompletableFuture.supplyAsync {
                    pingHost(hostname, port)
                }
                record.inProgress = future
                val result = try {
                    future.get()
                } catch (e: Exception) {
                    false
                }
                record.inProgress = null
                record.accessOk = result
                record.nextTry = System.currentTimeMillis() +
                    if (result) RETRY_OK_MS else RETRY_FAIL_MS
                return result
            }

            return record.accessOk
        }
    }

    private fun pingHost(host: String, port: Int): Boolean {
        val timeouts = intArrayOf(200, 300, 500)
        for (timeout in timeouts) {
            try {
                Socket().use { socket ->
                    socket.connect(InetSocketAddress(host, port), timeout)
                    return true
                }
            } catch (_: Exception) {
                Thread.sleep(timeout.toLong())
            }
        }
        return false
    }

    private fun isLocalAddress(address: String): Boolean {
        if (LOCALHOST_PATTERN.matches(address)) return true
        if (address == "0.0.0.0" || address == "::1" || address == "::") return true
        return false
    }

    companion object {
        private const val TAG = "TorRouteDecider"
        private const val RETRY_OK_MS = 30 * 60 * 1000L
        private const val RETRY_FAIL_MS = 10 * 60 * 1000L
        private val LOCALHOST_PATTERN = Regex("""^127(?:\.\d{1,3}){0,3}$""")
    }
}
