package com.forta.chat.plugins.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Audit S6-01, device check 2026-10-10: notifications drawn while the page
 * sleeps (the usual case on Android) never showed a contact alias. JS keeps the
 * aliases in their own SharedPreferences keys, which the push path never writes,
 * and every native title reads them first.
 */
class SenderAliasContractTest {

    private fun source(relative: String): String {
        val candidates = listOf("src/main/java/$relative", "android/app/src/main/java/$relative")
        return candidates.map { File(it) }.firstOrNull { it.exists() }?.readText()
            ?: error("$relative not found. Tried: $candidates from ${File(".").absolutePath}")
    }

    private val service by lazy { source("com/forta/chat/FortaFirebaseMessagingService.kt") }
    private val plugin by lazy { source("com/forta/chat/plugins/push/PushDataPlugin.kt") }

    @Test
    fun theAliasKeysAreWrittenOnlyFromJs() {
        val writes = Regex("putString\\(SENDER_ALIAS_PREFIX").findAll(service).toList()
        assertEquals(1, writes.size)
        val replace = service.indexOf("fun replaceSenderAliases(")
        assertTrue(replace >= 0 && writes.single().range.first > replace)
        val method = plugin.indexOf("fun cacheSenderAliases(")
        assertTrue(method >= 0 && plugin.indexOf("FortaFirebaseMessagingService.replaceSenderAliases(", method) > method)
    }

    @Test
    fun everyNativeTitleReadsTheAliasFirst() {
        assertTrue(service.contains("senderAlias = sender?.let { getSenderAlias(it) }"))
        assertEquals(2, Regex("senderAlias = sender\\?\\.let \\{ getSenderAlias\\(it\\) \\}").findAll(service).count())
        assertTrue(service.contains("showCallNotification(roomId, sender?.let { getSenderAlias(it) } ?: senderName"))
    }
}
