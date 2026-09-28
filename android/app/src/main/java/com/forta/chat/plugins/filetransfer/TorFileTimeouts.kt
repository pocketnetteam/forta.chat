package com.forta.chat.plugins.filetransfer

/**
 * Timeouts for TorFile transfers. HttpURLConnection waits forever by default, so a
 * Tor circuit that stalled after connecting held the transfer, and the media
 * download slot the app gave it, for good: after a few such stalls no media loaded
 * at all (audit S4-01).
 */
object TorFileTimeouts {
    /** Opening the connection to the local reverse proxy, which answers at once while it runs. */
    const val CONNECT_MS = 15_000

    /**
     * Longest silence while waiting for a download's headers or between two reads
     * of its body. The proxy streams the response as Tor delivers it, so this bounds
     * a stall, not the length of a large download.
     */
    const val DOWNLOAD_READ_MS = 60_000

    private const val UPLOAD_READ_FLOOR_MS = 5L * 60_000
    private const val UPLOAD_READ_CEILING_MS = 60L * 60_000

    /** Slowest Tor upload the wait allows for; the Samsung bench measured about 130 KB/s. */
    private const val UPLOAD_SLOWEST_BYTES_PER_SEC = 16L * 1024

    /**
     * How long an upload may wait for the server's answer. The proxy takes the whole
     * body at once and answers only after pushing it through Tor, so the wait grows
     * with the file.
     */
    fun uploadReadMs(fileSizeBytes: Long): Int {
        val bySize = fileSizeBytes.coerceIn(0L, 1L shl 40) * 1000 / UPLOAD_SLOWEST_BYTES_PER_SEC
        return (UPLOAD_READ_FLOOR_MS + bySize).coerceAtMost(UPLOAD_READ_CEILING_MS).toInt()
    }
}
