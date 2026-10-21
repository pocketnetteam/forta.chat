package com.forta.chat.plugins.push

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Samsung, 2026-10-10: a notification tap with the app closed opened the chat
 * list, not the chat. MainActivity is singleTask and its task outlives the
 * process, so Android recreates the activity from the task's launcher intent
 * and hands the tap over in onNewIntent, before the page has loaded. The tap
 * went out as a pushOpenRoom event nobody listened to yet. It now waits in the
 * buffer JS reads with getPendingIntent until a listener is there.
 */
class PushTapIntentContractTest {

    private val plugin by lazy {
        listOf("src/main/java", "android/app/src/main/java")
            .map { File("$it/com/forta/chat/plugins/push/PushDataPlugin.kt") }
            .first { it.exists() }
            .readText()
    }

    @Test
    fun aTapBeforeTheListenerExistsIsBufferedNotDropped() {
        val start = plugin.indexOf("private fun forwardPushIntent(")
        val body = plugin.substring(start, plugin.indexOf("\n    }\n", start))
        val check = body.indexOf("hasListeners(\"pushOpenRoom\")")
        assertTrue("forwardPushIntent must check for a JS listener:\n$body", check >= 0)
        assertTrue("and buffer the tap without one:\n$body", body.indexOf("pendingPushRoom = data", check) > check)
        assertTrue(body.indexOf("notifyListeners(\"pushOpenRoom\", data)") > check)
    }

    // Review 2026-10-10: onNewIntent runs on the main thread, addListener and
    // getPendingIntent on the plugin thread; the check-then-buffer and the read
    // share one lock so a tap cannot fall between them.
    @Test
    fun theBufferIsSharedUnderOneLock() {
        assertTrue(plugin.contains("@Volatile\n    private var pendingPushRoom"))
        val forward = plugin.substring(plugin.indexOf("private fun forwardPushIntent("))
        assertTrue(forward.substring(0, forward.indexOf("\n    }\n")).contains("synchronized(pendingLock)"))
        val read = plugin.substring(plugin.indexOf("fun getPendingIntent("))
        assertTrue(read.substring(0, read.indexOf("\n    }\n")).contains("synchronized(pendingLock)"))
    }
}
