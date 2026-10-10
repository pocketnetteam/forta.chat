package com.forta.chat.plugins.filetransfer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Audit S4-01: TorFile opened its connections with the default timeouts of 0, so a
 * stalled Tor circuit held a download, and one of the app's three media download
 * slots, forever.
 */
class TorFileTimeoutsTest {

    private val plugin by lazy {
        val relative = "com/forta/chat/plugins/filetransfer/TorFilePlugin.kt"
        listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
            .map { File(it) }.firstOrNull { it.exists() }?.readText() ?: error("$relative not found")
    }

    @Test
    fun uploadAndDownload_bothBoundTheirConnections() {
        assertEquals(2, Regex("conn\\.connectTimeout = TorFileTimeouts\\.CONNECT_MS").findAll(plugin).count())
        assertTrue(plugin.contains("conn.readTimeout = TorFileTimeouts.DOWNLOAD_READ_MS"))
        assertTrue(plugin.contains("conn.readTimeout = TorFileTimeouts.uploadReadMs(fileSize)"))
    }

    @Test
    fun timeoutsAreSet() {
        assertTrue(TorFileTimeouts.CONNECT_MS > 0)
        assertTrue(TorFileTimeouts.DOWNLOAD_READ_MS > 0)
    }

    @Test
    fun uploadWait_neverDropsBelowTheFloor() {
        assertEquals(5 * 60_000, TorFileTimeouts.uploadReadMs(0))
        assertEquals(5 * 60_000, TorFileTimeouts.uploadReadMs(-1))
    }

    @Test
    fun uploadWait_growsWithTheFile() {
        // 16 MB at the slowest allowed 16 KB/s is 1024 s on top of the floor.
        assertEquals(5 * 60_000 + 1_024_000, TorFileTimeouts.uploadReadMs(16L * 1024 * 1024))
        assertTrue(TorFileTimeouts.uploadReadMs(50L * 1024 * 1024) > TorFileTimeouts.uploadReadMs(5L * 1024 * 1024))
    }

    @Test
    fun uploadWait_isCappedAtAnHour() {
        assertEquals(60 * 60_000, TorFileTimeouts.uploadReadMs(4L * 1024 * 1024 * 1024))
        assertEquals(60 * 60_000, TorFileTimeouts.uploadReadMs(Long.MAX_VALUE))
    }
}
